// Eye-relative geometry, not a head-controlled pointer. All models run locally.
export const LEGACY_LENGTH = 120;
export const DETAIL_LENGTH = 192;
export const IRIS_LENGTH = 20;
export const PRECISION_PROFILES = [
  { name: 'iris', indices: Array.from({ length: IRIS_LENGTH }, (_, i) => LEGACY_LENGTH + DETAIL_LENGTH + i) },
  { name: 'iris-and-appearance', indices: Array.from({ length: DETAIL_LENGTH + IRIS_LENGTH }, (_, i) => LEGACY_LENGTH + i) },
  { name: 'appearance-baseline', indices: Array.from({ length: LEGACY_LENGTH }, (_, i) => i) },
];

function point(landmarks, index) {
  const value = landmarks?.[index];
  return value && Number.isFinite(value[0]) && Number.isFinite(value[1]) ? value : null;
}

function eyeGeometry(landmarks, startIndex, endIndex, upperIndex, lowerIndex, irisIndex) {
  const start = point(landmarks, startIndex), end = point(landmarks, endIndex);
  const upper = point(landmarks, upperIndex), lower = point(landmarks, lowerIndex);
  const iris = point(landmarks, irisIndex);
  if (!start || !end || !upper || !lower || !iris) return null;
  const width = Math.hypot(end[0] - start[0], end[1] - start[1]);
  if (width < 12) return { valid: false, reason: 'eyes-small' };
  const ux = (end[0] - start[0]) / width, uy = (end[1] - start[1]) / width;
  const x = ((iris[0] - start[0]) * ux + (iris[1] - start[1]) * uy) / width - 0.5;
  const y = ((iris[0] - (start[0] + end[0]) / 2) * -uy + (iris[1] - (start[1] + end[1]) / 2) * ux) / width;
  const opening = Math.abs((lower[0] - upper[0]) * -uy + (lower[1] - upper[1]) * ux) / width;
  const edge = point(landmarks, irisIndex + 1);
  const radius = edge ? Math.hypot(edge[0] - iris[0], edge[1] - iris[1]) / width : 0;
  const valid = Math.abs(x) < 0.65 && Math.abs(y) < 0.5 && opening >= 0.055;
  return { valid, reason: opening < 0.055 ? 'blink' : valid ? 'good' : 'iris-unreliable', x, y, opening, radius, width };
}

export function irisFeatures(landmarks) {
  const right = eyeGeometry(landmarks, 33, 133, 159, 145, 468);
  const left = eyeGeometry(landmarks, 362, 263, 386, 374, 473);
  if (!right || !left) return { valid: false, reason: 'iris-missing', vector: null };
  if (!right.valid || !left.valid) return { valid: false, reason: !right.valid ? right.reason : left.reason, vector: null };
  const x = (right.x + left.x) / 2, y = (right.y + left.y) / 2;
  const vector = [right.x, right.y, left.x, left.y, x, y, right.x - left.x, right.y - left.y, x*x, y*y, x*y, right.x**2, right.y**2, left.x**2, left.y**2, right.x*right.y, left.x*left.y, right.opening, left.opening, (right.radius+left.radius)/2];
  return { valid: true, reason: 'good', vector, minEyeWidth: Math.min(right.width, left.width) };
}

function grayscale(data, width, x, y) {
  const offset = (y * width + x) * 4;
  return (data[offset] * 0.299 + data[offset+1] * 0.587 + data[offset+2] * 0.114) / 255;
}

export function detailedEyeAppearance(eye) {
  const patch = eye.patch;
  const width = patch.width, height = patch.height;
  if (!width || !height) throw new Error('Invalid eye patch');
  const output = [];
  for (let row = 0; row < 8; row++) for (let col = 0; col < 12; col++) {
    const sx = Math.max(0, Math.min(width-1, (col+0.5)*width/12-0.5));
    const sy = Math.max(0, Math.min(height-1, (row+0.5)*height/8-0.5));
    const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(width-1,x0+1), y1 = Math.min(height-1,y0+1);
    const dx = sx-x0, dy = sy-y0;
    output.push((1-dy)*((1-dx)*grayscale(patch.data,width,x0,y0)+dx*grayscale(patch.data,width,x1,y0))+dy*((1-dx)*grayscale(patch.data,width,x0,y1)+dx*grayscale(patch.data,width,x1,y1)));
  }
  const mean = output.reduce((sum,value)=>sum+value,0)/output.length;
  const scale = Math.max(0.035,Math.sqrt(output.reduce((sum,value)=>sum+(value-mean)**2,0)/output.length));
  return output.map(value=>Math.max(-3,Math.min(3,(value-mean)/scale))/6+0.5);
}

export function combinedEyeFeatures(eyes, legacyExtractor, geometry = null) {
  return [...legacyExtractor(eyes).map(value=>value/255), ...detailedEyeAppearance(eyes.left), ...detailedEyeAppearance(eyes.right), ...(geometry || Array(IRIS_LENGTH).fill(0))];
}
