import test from 'node:test';
import assert from 'node:assert/strict';
import { irisFeatures, detailedEyeAppearance, combinedEyeFeatures } from '../dist/eye-features.mjs';
import { PrecisionCalibration } from '../dist/precision-model.mjs';
import { pointsFor } from '../dist/core.mjs';

function landmarks() {
  const points = Array.from({length:478},()=>[0,0,0]);
  for (const [start,end,upper,lower,iris,x] of [[33,133,159,145,468,100],[362,263,386,374,473,200]]) {
    points[start]=[x,100]; points[end]=[x+40,100];
    points[upper]=[x+20,95]; points[lower]=[x+20,105];
    points[iris]=[x+24,101]; points[iris+1]=[x+28,101];
  }
  return points;
}

test('iris features preserve eye-relative geometry under translation, distance scale and roll', () => {
  const source=landmarks(), expected=irisFeatures(source);
  assert.equal(expected.valid,true);
  assert.equal(expected.vector.length,20);
  const angle=0.23, scale=1.6;
  const transformed=source.map(([x,y])=>[scale*(x*Math.cos(angle)-y*Math.sin(angle))+71,scale*(x*Math.sin(angle)+y*Math.cos(angle))-19]);
  const actual=irisFeatures(transformed);
  assert.equal(actual.valid,true);
  actual.vector.forEach((value,i)=>assert.ok(Math.abs(value-expected.vector[i])<1e-12));
});

test('closed eyes, too-small eyes and absent iris landmarks cannot train or predict', () => {
  const closed=landmarks(); closed[159]=closed[145]=[120,100];
  assert.equal(irisFeatures(closed).reason,'blink');
  assert.equal(irisFeatures(landmarks().map(p=>p.map(v=>v/5))).reason,'eyes-small');
  assert.equal(irisFeatures(landmarks().slice(0,468)).reason,'iris-missing');
});

function patch(brightness=0) {
  const width=24,height=16,data=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const value=80+brightness+Math.round(25*Math.sin(x/3)+15*Math.cos(y/2));
    data.set([value,value,value,255],(y*width+x)*4);
  }
  return {patch:{width,height,data}};
}

test('normalized appearance tolerates uniform lighting changes and produces finite 332D features', () => {
  const a=detailedEyeAppearance(patch()),b=detailedEyeAppearance(patch(45));
  assert.equal(a.length,96);
  assert.ok(a.every((v,i)=>Math.abs(v-b[i])<1e-12));
  const vector=combinedEyeFeatures({left:patch(),right:patch()},()=>Array(120).fill(128),irisFeatures(landmarks()).vector);
  assert.equal(vector.length,332);
  assert.ok(vector.every(Number.isFinite));
});

function features(x,y,sample=0) {
  const values=Array.from({length:332},(_,i)=>0.5+Math.sin((i+1)*17.13+(sample+1)*39.7)*0.15);
  const iris=[x,y,x,y,x,y,0,0,x*x,y*y,x*y,x*x,y*y,x*x,y*y,x*y,x*y,0.25,0.25,0.1];
  iris.forEach((value,i)=>{values[312+i]=value+Math.sin(sample*7+i*3)*0.0002;});
  return values;
}

test('16 calibration targets exclude validation targets; calibration alone selects an accurate frozen model', () => {
  const calibration=pointsFor('precision',1200,800), validation=pointsFor('validation',1200,800);
  assert.equal(calibration.length,16);
  assert.ok(validation.every(v=>!calibration.some(c=>c.x===v.x&&c.y===v.y)));
  const model=new PrecisionCalibration();
  for(const target of calibration) for(let i=0;i<20;i++) model.addData(features(target.x/1200,target.y/800,i),[target.x,target.y]);
  const diagnostics=model.fit({width:1200,height:800,requiredTargets:16,minSamples:12});
  assert.equal(diagnostics.profile,'iris');
  assert.equal(diagnostics.selection.candidates.length,9);
  assert.equal(diagnostics.targetCount,16);
  assert.equal(diagnostics.retainedSamples,320);
  assert.equal(diagnostics.usedSamples,16*17);
  for(const target of validation) {
    const p=model.predict(features(target.x/1200,target.y/800,37));
    assert.ok(Math.hypot(p.x-target.x,p.y-target.y)<15);
  }
  assert.equal(model.addData(features(0.5,0.5),[600,400]),false);
  assert.deepEqual(model.diagnostics(),diagnostics);
  assert.equal(model.predict(null),null);
  assert.equal(model.predict(Array(332).fill(NaN)),null);
  model.init();
  assert.equal(model.fittedModel,null);
  assert.equal(model.diagnostics().retainedSamples,0);
  assert.throws(()=>model.fit({width:1200,height:800,requiredTargets:16}),/校准位置/);
});

test('unstable calibration outliers are trimmed without losing screen targets', () => {
  const model=new PrecisionCalibration();
  for(const target of pointsFor('precision',1200,800)) {
    for(let i=0;i<20;i++) {
      const vector=features(target.x/1200,target.y/800,i);
      if(i>=18) for(let j=0;j<vector.length;j++) vector[j]+=8;
      model.addData(vector,[target.x,target.y]);
    }
  }
  const result=model.fit({width:1200,height:800,requiredTargets:16,minSamples:12});
  assert.equal(result.targetCount,16);
  const p=model.predict(features(0.45,0.45,37));
  assert.ok(Math.hypot(p.x-540,p.y-360)<20);
});
