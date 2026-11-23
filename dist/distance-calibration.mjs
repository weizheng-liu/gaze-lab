import {finitePrediction,quantile} from './core.mjs';
import {cholesky,solve} from './regression.mjs';

export const MIN_DISTANCE_SAMPLES=8;
export const DISTANCE_RANGES={near:[0.72,0.93],far:[1.07,1.30]};

export function distanceTargets({width,height}) {
  const positions=[[0.25,0.27],[0.75,0.30],[0.5,0.75]];
  return ['near','far'].flatMap(side=>positions.map(([x,y])=>({side,x:x*width,y:y*height})));
}

export function distanceSide(ratio) {
  if(!Number.isFinite(ratio))return null;
  return Object.keys(DISTANCE_RANGES).find(side=>{
    const [low,high]=DISTANCE_RANGES[side];
    return ratio>=low&&ratio<=high;
  })??null;
}

function features(x,y,depth) {return [depth,depth*(x-0.5),depth*(y-0.5)];}

export function fitDistanceCorrection(groups,{width,height}) {
  if(groups.length!==6||groups.some(group=>group.samples.length<MIN_DISTANCE_SAMPLES))throw new Error('近／远校准的有效样本不足。');
  const points=groups.map(({target,samples})=>({
    x:quantile(samples.map(sample=>sample.x/width),0.5),
    y:quantile(samples.map(sample=>sample.y/height),0.5),
    ratio:quantile(samples.map(sample=>sample.ratio),0.5),
    target,
  }));
  const normal=new Float64Array(9), mx=new Float64Array(3), my=new Float64Array(3);
  for(const point of points) {
    const row=features(point.x,point.y,point.ratio-1);
    for(let i=0;i<3;i++) {
      mx[i]+=row[i]*(point.target.x/width-point.x);
      my[i]+=row[i]*(point.target.y/height-point.y);
      for(let j=0;j<=i;j++)normal[i*3+j]+=row[i]*row[j];
    }
  }
  // Penalize location-dependent terms more strongly than a screen-wide offset.
  for(let i=0;i<3;i++)normal[i*3+i]+=i===0?0.0002:0.001;
  const lower=cholesky(normal,3);
  const model={
    x:Array.from(solve(lower,mx)),y:Array.from(solve(lower,my)),width,height,
    minRatio:Math.min(...points.map(point=>point.ratio)),
    maxRatio:Math.max(...points.map(point=>point.ratio)),
  };
  const error=(point,model)=>{
    const screenPoint={x:point.x*width,y:point.y*height};
    const prediction=applyDistanceCorrection(screenPoint,point.ratio,model);
    return Math.hypot(prediction.x-point.target.x,prediction.y-point.target.y);
  };
  if(points.reduce((total,point)=>total+error(point,model),0)>=points.reduce((total,point)=>total+error(point,null),0)) {
    throw new Error('这轮距离采样没有得到可用修正。可以重新采样。');
  }
  return model;
}

export function applyDistanceCorrection(point,ratio,model) {
  if(!model||!finitePrediction(point)||!Number.isFinite(ratio)||ratio===1)return point;
  const edge=ratio<1?model.minRatio:model.maxRatio;
  // Avoid extrapolating a correction far beyond the calibrated positions.
  const overshoot=Math.max(0,Math.abs(ratio-1)-Math.abs(edge-1));
  const fade=Math.max(0,1-overshoot/0.12);
  const depth=(Math.abs(ratio-1)>Math.abs(edge-1)?edge:ratio)-1;
  const row=features(point.x/model.width,point.y/model.height,depth);
  const shift=coefficients=>Math.max(-0.2,Math.min(0.2,row.reduce((sum,value,i)=>sum+value*coefficients[i],0)))*fade;
  return {x:point.x+shift(model.x)*model.width,y:point.y+shift(model.y)*model.height};
}
