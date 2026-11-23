import { CalibrationRidge } from './regression.mjs';
import { PRECISION_PROFILES } from './eye-features.mjs';

const median = values => {
  const sorted = [...values].sort((a,b)=>a-b), middle = Math.floor(sorted.length/2);
  return sorted.length%2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2;
};

function stableGroup(group, minimum) {
  if (group.samples.length < 12) return group;
  const dimensions = group.samples[0].length;
  const center = Array.from({length:dimensions},(_,i)=>median(group.samples.map(sample=>sample[i])));
  const scale = center.map((value,i)=>Math.max(0.01,median(group.samples.map(sample=>Math.abs(sample[i]-value)))*1.4826));
  const ranked = group.samples.map(sample=>({sample,score:sample.reduce((sum,value,i)=>sum+Math.min(25,((value-center[i])/scale[i])**2),0)/dimensions})).sort((a,b)=>a.score-b.score);
  return {...group,samples:ranked.slice(0,Math.max(minimum,Math.ceil(group.samples.length*0.85))).map(entry=>entry.sample)};
}

function project(sample, profile) { return profile.indices.map(index=>sample[index]); }

function fitSubset(groups, profile, width, height, lambda, minSamples) {
  const model = new CalibrationRidge();
  model.groups = new Map(groups.map((group,i)=>[String(i),{target:group.target,samples:group.samples.map(sample=>project(sample,profile))}]));
  model.fit({width,height,lambda,minSamples,requiredTargets:groups.length});
  return model;
}

export class PrecisionCalibration extends CalibrationRidge {
  init() {
    super.init();
    this.name = 'precision-calibration-ridge';
    this.fittedModel = null;
    this.selectedProfile = null;
    this.selection = null;
    this.usedSamples = 0;
  }

  fit({width,height,requiredTargets=9,minSamples=8,profiles=PRECISION_PROFILES}) {
    const raw = [...this.groups.values()].sort((a,b)=>a.target[1]-b.target[1]||a.target[0]-b.target[0]);
    if (raw.length!==requiredTargets || raw.some(group=>group.samples.length<minSamples)) throw new Error('部分校准位置的数据不足，请重新完成全部位置。');
    const dimensions = raw[0].samples[0].length;
    if (raw.some(group=>group.samples.some(sample=>sample.length!==dimensions))) throw new Error('眼部特征维度变化，请重新校准。');
    if (profiles.some(profile=>!profile.indices.length||profile.indices.some(i=>i<0||i>=dimensions))) throw new Error('Invalid feature profile');
    const groups = raw.map(group=>stableGroup(group,minSamples));
    const folds = Math.min(4,Math.floor(groups.length/2));
    const side = Math.ceil(Math.sqrt(groups.length));
    const foldFor = index=>(index+Math.floor(index/side))%folds;
    const scores = [];
    for (const profile of profiles) for (const lambda of [0.01,0.1,1]) {
      const targetErrors = [];
      for (let fold=0;fold<folds;fold++) {
        const train = groups.filter((_,i)=>foldFor(i)!==fold);
        const holdout = groups.filter((_,i)=>foldFor(i)===fold);
        const model = fitSubset(train,profile,width,height,lambda,minSamples);
        for (const group of holdout) {
          const errors = group.samples.map(sample=>{const p=model.predict(project(sample,profile));return Math.hypot(p.x-group.target[0],p.y-group.target[1]);});
          targetErrors.push(median(errors));
        }
      }
      scores.push({profile:profile.name,lambda,errorPx:targetErrors.reduce((a,b)=>a+b,0)/targetErrors.length});
    }
    // Prefer the simpler first profile when the improvement is less than 2%.
    let best = scores[0];
    for (const candidate of scores.slice(1)) if (candidate.errorPx<best.errorPx*0.98) best=candidate;
    this.selectedProfile = profiles.find(profile=>profile.name===best.profile);
    this.fittedModel = fitSubset(groups,this.selectedProfile,width,height,best.lambda,minSamples);
    this.model = this.fittedModel.model;
    this.selection = {method:'grouped-calibration-target-cross-validation',folds,scorePx:best.errorPx,candidates:scores};
    this.usedSamples = groups.reduce((sum,group)=>sum+group.samples.length,0);
    this.fitCount++;
    this.frozen = true;
    return this.diagnostics();
  }

  predict(eyes) {
    if (!this.fittedModel || !eyes) return null;
    const sample = this.extractFeatures(eyes);
    if (!sample || this.selectedProfile.indices.some(i=>!Number.isFinite(sample[i]))) return null;
    return this.fittedModel.predict(project(sample,this.selectedProfile));
  }

  diagnostics() {
    return {...super.diagnostics(),usedSamples:this.usedSamples,profile:this.selectedProfile?.name??null,selection:this.selection};
  }
}

export function installPrecisionRegression(webgazer,extractFeatures) {
  class SessionPrecision extends PrecisionCalibration { constructor(){super(extractFeatures);} }
  webgazer.addRegressionModule('precision-calibration-ridge',SessionPrecision);
  webgazer.setRegression('precision-calibration-ridge');
  return webgazer.getRegression()[0];
}
