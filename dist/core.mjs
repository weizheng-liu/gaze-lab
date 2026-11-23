// All coordinates are viewport CSS pixels. Scoring never clamps predictions.
export const PROTOCOL = Object.freeze({ settleMs: 1000, captureMs: 2000, calibrationIntervalMs: 100, minCalibrationSamples: 12 });
export const NATURAL_PROTOCOL=Object.freeze({...PROTOCOL,minCalibrationSamples:8,referenceMs:2000,maxResultAgeMs:250});

export function pointsFor(kind, width, height) {
  const fractions = kind === 'precision' ? [0.08, 0.36, 0.64, 0.92] : kind === 'calibration' ? [0.1, 0.5, 0.9] : kind === 'validation16' ? [0.14, 0.38, 0.62, 0.86] : [0.2, 0.45, 0.8];
  return fractions.flatMap((y, row) => fractions.map((x, col) => ({ id: row * fractions.length + col + 1, x: x * width, y: y * height })));
}

export function shuffled(values, random = Math.random) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export class TargetClock {
  constructor(points, now, options = PROTOCOL) {
    this.points = points;
    this.index = 0;
    this.elapsed = 0;
    this.lastAt = now;
    this.settleMs = options.settleMs;
    this.captureMs = options.captureMs;
  }
  get done() { return this.index >= this.points.length; }
  get point() { return this.points[this.index] ?? null; }
  get capturing() { return !this.done && this.elapsed >= this.settleMs; }
  update(now, enabled = true, allowFinish = true) {
    const delta = Math.max(0, now - this.lastAt);
    this.lastAt = Math.max(this.lastAt, now);
    if (!enabled || this.done) return false;
    this.elapsed += delta;
    if (this.elapsed >= this.settleMs + this.captureMs) {
      if (!allowFinish) {
        this.elapsed = this.settleMs + this.captureMs;
        return false;
      }
      this.index++;
      this.elapsed = 0;
      return true;
    }
    return false;
  }
}

export function finitePrediction(prediction) {
  return Boolean(prediction && Number.isFinite(prediction.x) && Number.isFinite(prediction.y));
}

export function gridCell(x, y, width, height) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= width || y >= height) return -1;
  return Math.floor(y / height * 3) * 3 + Math.floor(x / width * 3);
}

export function quantile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  const low = Math.floor(index);
  return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
}

export function summarize(samples, targets, width, height, captureMs = PROTOCOL.captureMs) {
  const valid = samples.filter(s => s.valid && finitePrediction({ x: s.x, y: s.y }));
  const errors = valid.map(s => Math.hypot(s.x - s.targetX, s.y - s.targetY));
  const diagonal = Math.hypot(width, height);
  const hits = valid.filter(s => gridCell(s.x, s.y, width, height) === gridCell(s.targetX, s.targetY, width, height)).length;
  const median = quantile(errors, 0.5);
  const p90 = quantile(errors, 0.9);
  let squaredJitter = 0;
  let jitterCount = 0;
  const perTarget = targets.map(target => {
    const all = samples.filter(s => s.targetId === target.id);
    const group = valid.filter(s => s.targetId === target.id);
    const meanX = group.length ? group.reduce((sum, s) => sum + s.x, 0) / group.length : null;
    const meanY = group.length ? group.reduce((sum, s) => sum + s.y, 0) / group.length : null;
    const squares = group.map(s => (s.x - meanX) ** 2 + (s.y - meanY) ** 2);
    if (group.length > 1) {
      squaredJitter += squares.reduce((sum, n) => sum + n, 0);
      jitterCount += group.length;
    }
    return { ...target, attemptedSamples: all.length, validSamples: group.length, meanX, meanY, medianErrorPx: quantile(group.map(s => Math.hypot(s.x - target.x, s.y - target.y)), 0.5), jitterRmsPx: group.length > 1 ? Math.sqrt(squares.reduce((sum, n) => sum + n, 0) / group.length) : null };
  });
  return {
    attemptedSamples: samples.length, validSamples: valid.length,
    validPredictionRate: samples.length ? valid.length / samples.length : null,
    medianErrorPx: median, p90ErrorPx: p90,
    medianErrorDiagonalPct: median === null ? null : median / diagonal * 100,
    p90ErrorDiagonalPct: p90 === null ? null : p90 / diagonal * 100,
    gridHitRate: valid.length ? hits / valid.length : null,
    jitterRmsPx: jitterCount > 1 ? Math.sqrt(squaredJitter / jitterCount) : null,
    predictionHz: valid.length / (targets.length * captureMs / 1000),
    targetsWithData: perTarget.filter(t => t.validSamples > 0).length,
    perTarget,
  };
}

export function trainingAllowed(mode, capturing, eyesValid) {
  return mode === 'calibration' && capturing && eyesValid;
}

export function pairedSummaries(samples,targets,width,height) {
  const paired=samples.map(s=>({...s,valid:s.valid&&Number.isFinite(s.beforeX)&&Number.isFinite(s.beforeY)}));
  const after=summarize(paired,targets,width,height);
  const before=summarize(paired.map(s=>({...s,x:s.beforeX,y:s.beforeY})),targets,width,height);
  return {before,after,pairedSamples:after.validSamples,medianImprovementPct:before.medianErrorPx>0?(before.medianErrorPx-after.medianErrorPx)/before.medianErrorPx*100:null};
}

// Display only: reject isolated spikes before the existing time-based smoothing.
// Validation and exports continue using unmodified predictions.
export class DisplayStabilizer {
  constructor() { this.reset(); }
  reset() { this.points = []; this.lastAt = -Infinity; }
  push(prediction, now) {
    if (!finitePrediction(prediction)) { this.reset(); return null; }
    if (now - this.lastAt > 750) this.reset();
    this.lastAt = now;
    this.points.push({ x: prediction.x, y: prediction.y });
    if (this.points.length > 3) this.points.shift();
    return { x: quantile(this.points.map(p => p.x), 0.5), y: quantile(this.points.map(p => p.y), 0.5) };
  }
}

export function samplesToCsv(samples) {
  const columns = ['roundId', 'condition', 'timeMs', 'targetId', 'targetX', 'targetY', 'x', 'y', 'valid', 'eyesDetected', 'errorPx', 'viewportWidth', 'viewportHeight','trackingMode','motionKind','modelId','provider','beforeX','beforeY','beforeErrorPx','distanceRatio','headYawDeg','headPitchDeg','headRollDeg','poseFitError','latencyMs','qualityReason',
    'frameId','frameAgeMs','calibrationId','calibrationPoints','testPoints','screenSizeSource','screenWidthCm','screenHeightCm','screenResolutionWidth','screenResolutionHeight','cameraPositionSource','cameraXCm','cameraYCm','cameraWidth','cameraHeight','cameraFrameRate','cameraFacingMode',
    'distanceCalibrationId','geometryX','geometryY','gazeYawDeg','gazePitchDeg'];
  const escape = value => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return '\uFEFF' + [columns.join(','), ...samples.map(s => columns.map(c => escape(s[c])).join(','))].join('\r\n');
}
