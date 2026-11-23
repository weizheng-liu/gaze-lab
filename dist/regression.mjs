// Session calibration must retain every target. WebGazer's stock 50-sample
// rolling window drops early screen rows during a nine-point calibration.
export class CalibrationRidge {
  constructor(extractFeatures = value => value) {
    this.extractFeatures = extractFeatures;
    this.name = 'session-calibration-ridge';
    this.init();
  }

  init() {
    this.groups = new Map();
    this.model = null;
    this.revision = 0;
    this.fitCount = 0;
    this.frozen = false;
  }

  addData(eyes, screenPosition, type = 'click') {
    if (this.frozen || !eyes || type !== 'click') return false;
    const features = Array.from(this.extractFeatures(eyes));
    if (!features.length || !features.every(Number.isFinite) || !screenPosition?.every(Number.isFinite)) return false;
    const key = screenPosition.join(',');
    let group = this.groups.get(key);
    if (!group) {
      // Limit unexpected inputs without evicting any legitimate calibration point.
      if (this.groups.size >= 25) return false;
      group = { target: [...screenPosition], samples: [] };
      this.groups.set(key, group);
    }
    if (group.samples.length >= 32) group.samples.shift();
    group.samples.push(features);
    this.revision++;
    return true;
  }

  fit({ width, height, requiredTargets = 9, minSamples = 8, lambda = 0.1 }) {
    const groups = [...this.groups.values()];
    if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) throw new Error('测试窗口尺寸无效，请重新校准。');
    if (groups.length !== requiredTargets || groups.some(group => group.samples.length < minSamples)) {
      throw new Error(`部分校准位置的数据不足，请重新完成全部 ${requiredTargets} 个位置。`);
    }
    if (!(lambda > 0)) throw new Error('Invalid ridge regularization');
    const dimensions = groups[0].samples[0].length;
    const mean = new Float64Array(dimensions);
    const variance = new Float64Array(dimensions);
    const targetMean = new Float64Array(2);
    const records = [];
    for (const group of groups) {
      const weight = 1 / (groups.length * group.samples.length);
      for (const features of group.samples) {
        if (features.length !== dimensions) throw new Error('眼部特征维度变化，请重新校准。');
        records.push({ features, weight, x: group.target[0] / width, y: group.target[1] / height });
        for (let i = 0; i < dimensions; i++) mean[i] += features[i] * weight;
        targetMean[0] += group.target[0] / width * weight;
        targetMean[1] += group.target[1] / height * weight;
      }
    }
    for (const { features, weight } of records) {
      for (let i = 0; i < dimensions; i++) variance[i] += (features[i] - mean[i]) ** 2 * weight;
    }
    const scale = Float64Array.from(variance, value => Math.max(0.02, Math.sqrt(value)));
    const matrix = new Float64Array(dimensions * dimensions);
    const rhsX = new Float64Array(dimensions);
    const rhsY = new Float64Array(dimensions);
    for (const record of records) {
      const vector = Float64Array.from(record.features, (value, i) => (value - mean[i]) / scale[i]);
      for (let i = 0; i < dimensions; i++) {
        const weighted = vector[i] * record.weight;
        rhsX[i] += weighted * (record.x - targetMean[0]);
        rhsY[i] += weighted * (record.y - targetMean[1]);
        for (let j = 0; j <= i; j++) matrix[i * dimensions + j] += weighted * vector[j];
      }
    }
    for (let i = 0; i < dimensions; i++) {
      matrix[i * dimensions + i] += lambda;
      for (let j = 0; j < i; j++) matrix[j * dimensions + i] = matrix[i * dimensions + j];
    }
    const lower = cholesky(matrix, dimensions);
    this.model = { mean, scale, targetMean, coefficientsX: solve(lower, rhsX), coefficientsY: solve(lower, rhsY), width, height, lambda };
    this.fitCount++;
    this.frozen = true;
    return this.diagnostics();
  }

  predict(eyes) {
    if (!this.model || !eyes) return null;
    const features = this.extractFeatures(eyes);
    const model = this.model;
    if (!features || features.length !== model.mean.length) return null;
    let x = model.targetMean[0];
    let y = model.targetMean[1];
    for (let i = 0; i < features.length; i++) {
      if (!Number.isFinite(features[i])) return null;
      const value = (features[i] - model.mean[i]) / model.scale[i];
      x += value * model.coefficientsX[i];
      y += value * model.coefficientsY[i];
    }
    return { x: x * model.width, y: y * model.height };
  }

  diagnostics() {
    const targets = [...this.groups.values()].map(group => ({ x: group.target[0], y: group.target[1], samples: group.samples.length }));
    return { name: this.name, targetCount: targets.length, retainedSamples: targets.reduce((sum, target) => sum + target.samples, 0), targets, fitCount: this.fitCount, frozen: this.frozen, lambda: this.model?.lambda ?? null };
  }

  // Cross-session loading is disabled. Do not retain eye images or export features.
  getData() { return []; }
  setData() {}
}

export function cholesky(matrix, size) {
  const lower = new Float64Array(matrix.length);
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= i; j++) {
      let value = matrix[i * size + j];
      for (let k = 0; k < j; k++) value -= lower[i * size + k] * lower[j * size + k];
      if (i === j) {
        if (!(value > 0)) throw new Error('校准模型求解失败，请重新校准。');
        lower[i * size + j] = Math.sqrt(value);
      } else lower[i * size + j] = value / lower[j * size + j];
    }
  }
  return lower;
}

export function solve(lower, rhs) {
  const size = rhs.length;
  const temporary = new Float64Array(size);
  const result = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    let value = rhs[i];
    for (let j = 0; j < i; j++) value -= lower[i * size + j] * temporary[j];
    temporary[i] = value / lower[i * size + i];
  }
  for (let i = size - 1; i >= 0; i--) {
    let value = temporary[i];
    for (let j = i + 1; j < size; j++) value -= lower[j * size + i] * result[j];
    result[i] = value / lower[i * size + i];
  }
  return result;
}

export function installCalibrationRegression(webgazer) {
  class SessionRegression extends CalibrationRidge {
    constructor() { super(eyes => webgazer.util.getEyeFeats(eyes).map(value => value / 255)); }
  }
  webgazer.addRegressionModule('session-calibration-ridge', SessionRegression);
  webgazer.setRegression('session-calibration-ridge');
  return webgazer.getRegression()[0];
}
