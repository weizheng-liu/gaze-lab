import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {FaceGeometry,similarityFit,rotate,multiply,projectGaze,gazeVector,eyeOrigin,projectToDisplay} from '../dist/face-geometry.mjs';
import {normalizeRgba,decodeAngles,freshResult,faceBounds} from '../dist/gaze-input.mjs';
import {RayCalibration} from '../dist/ray-calibration.mjs';
import {applyDistanceCorrection,distanceSide,distanceTargets,fitDistanceCorrection} from '../dist/distance-calibration.mjs';
import {pointsFor,pairedSummaries,samplesToCsv} from '../dist/core.mjs';

const template=JSON.parse(await readFile(new URL('../dist/vendor/compensation/canonical-face.json',import.meta.url),'utf8'));
const canonical=template.map(([x,y,z])=>[x,-y,-z]);
const radians=degrees=>degrees*Math.PI/180;

test('distance calibration corrects synthetic bias at held-out points and preserves the reference distance',()=>{
  const size={width:1280,height:800};
  const biased=(target,ratio)=>{
    const d=ratio-1;
    return {
      x:(target.x/size.width-0.45*d+0.2*d)/(1+0.4*d)*size.width,
      y:target.y+0.23*d*size.height,
      ratio,
    };
  };
  const groups=distanceTargets(size).map(target=>({
    target,samples:Array.from({length:9},(_,i)=>{
      const result=biased(target,target.side==='near'?0.84:1.16);
      if(i===8)result.x+=1000;
      return result;
    }),
  }));
  const model=fitDistanceCorrection(groups,size);
  for(const target of pointsFor('validation16',size.width,size.height)) {
    assert.ok(groups.every(group=>group.target.x!==target.x||group.target.y!==target.y));
    for(const ratio of [0.87,1.12]) {
      const before=biased(target,ratio);
      const after=applyDistanceCorrection(before,ratio,model);
      const error=point=>Math.hypot(point.x-target.x,point.y-target.y);
      assert.ok(error(after)<error(before)*0.25);
    }
  }
  const center={x:640,y:400};
  assert.deepEqual(applyDistanceCorrection(center,1,model),center);
  assert.deepEqual(applyDistanceCorrection(center,1.5,model),center);
  assert.equal(distanceSide(0.88),'near');
  assert.equal(distanceSide(1.12),'far');
  assert.equal(distanceSide(1),null);
  assert.throws(()=>fitDistanceCorrection(groups.slice(1),size),/有效样本不足/);
});
function rotation(yaw=0,pitch=0,roll=0) {
  const y=radians(yaw),p=radians(pitch),r=radians(roll);
  return multiply(multiply([Math.cos(r),-Math.sin(r),0,Math.sin(r),Math.cos(r),0,0,0,1],[Math.cos(y),0,Math.sin(y),0,1,0,-Math.sin(y),0,Math.cos(y)]),[1,0,0,0,Math.cos(p),-Math.sin(p),0,Math.sin(p),Math.cos(p)]);
}
function landmarks(scale=20,r=rotation(),translation=[640,360,0]) {
  const points=canonical.map(p=>rotate(r,p).map((v,i)=>v*scale+translation[i]));
  for(const [iris,start,end] of [[468,33,133],[473,362,263]]) {
    const center=points[start].map((v,i)=>(v+points[end][i])/2);
    for(let i=0;i<5;i++)points[iris+i]=[...center];
  }
  return points;
}
test('3D similarity fit separates rotation, scale and translation',()=>{
  const r=rotation(19,-13,17),scale=0.82,t=[38,-72,11];
  const target=canonical.map(p=>rotate(r,p).map((v,i)=>v*scale+t[i]));
  const result=similarityFit(canonical,target);
  assert.ok(result.residual<1e-9);
  assert.ok(Math.abs(result.scale-scale)<1e-9);
  result.rotation.forEach((v,i)=>assert.ok(Math.abs(v-r[i])<1e-8));
  result.translation.forEach((v,i)=>assert.ok(Math.abs(v-t[i])<1e-8));
  assert.equal(similarityFit([],[]),null);
});
test('reference posture reports relative degrees and rotation-corrected distance ratio',()=>{
  const geometry=new FaceGeometry(template);
  geometry.beginReference();
  const neutral=geometry.estimate(landmarks(),1280,720);
  for(let i=0;i<20;i++)geometry.capture(neutral);
  geometry.finishReference();
  const current=geometry.estimate(landmarks(16,rotation(20,-12,15)),1280,720);
  const pose=geometry.relative(current);
  assert.ok(Math.abs(pose.distanceRatio-1.25)<1e-8);
  assert.ok(Math.abs(pose.yaw-20)<1e-8);
  assert.ok(Math.abs(pose.pitch+12)<1e-8);
  assert.ok(Math.abs(pose.roll-15)<1e-8);
  const turned=geometry.relative(geometry.estimate(landmarks(20,rotation(25,14,-18)),1280,720));
  assert.ok(Math.abs(turned.distanceRatio-1)<1e-8,'turning must not imply a larger distance');
  geometry.resetReference();assert.equal(geometry.reference,null);
  assert.throws(()=>geometry.finishReference(),/样本不足/);
});
test('invalid or nonrigid face geometry is rejected',()=>{
  const geometry=new FaceGeometry(template);
  assert.equal(geometry.estimate([],1280,720),null);
  const invalid=landmarks();invalid[33][0]=NaN;
  assert.equal(geometry.estimate(invalid,1280,720),null);
  const distorted=landmarks();for(let i=0;i<468;i++)distorted[i][0]+=Math.sin(i*5)*500;
  assert.equal(geometry.estimate(distorted,1280,720),null);
});
test('ray projection preserves a fixed screen target across head positions and distance changes',()=>{
  const target=[0.19,-0.08],reference={scale:20,eye:[0,0]};
  for(const distance of [0.8,1,1.2]) for(const eye of [[0,0],[0.07,-0.05],[-0.08,0.06]]) {
    const ray=[target[0]-eye[0]*distance,target[1]-eye[1]*distance,-distance],length=Math.hypot(...ray),v=ray.map(x=>x/length);
    const gaze={yaw:Math.atan2(-v[0],-v[2]),pitch:Math.asin(-v[1])};
    const actual=projectGaze(gaze,{scale:20/distance,eye},reference);
    actual.forEach((value,i)=>assert.ok(Math.abs(value-target[i])<1e-10));
  }
  assert.deepEqual(gazeVector(0,0),[-0,-0,-1]);
  assert.equal(projectGaze({yaw:Math.PI,pitch:0},{scale:20,eye:[0,0]},reference),null);
});
test('official RGB/CHW normalization and 90-bin angle decode preserve signs and units',()=>{
  const output=normalizeRgba(new Uint8Array([255,128,0,255,0,255,128,255]));
  assert.equal(output.length,6);
  assert.ok(Math.abs(output[0]-(1-0.485)/0.229)<1e-6);
  assert.ok(Math.abs(output[2]-(128/255-0.456)/0.224)<1e-6);
  assert.ok(Math.abs(output[4]-(0-0.406)/0.225)<1e-6);
  const yaw=Array(90).fill(-100),pitch=Array(90).fill(-100);yaw[50]=100;pitch[42]=100;
  const angles=decodeAngles(yaw,pitch);
  assert.ok(Math.abs(angles.yaw-radians(20))<1e-10);
  assert.ok(Math.abs(angles.pitch-radians(-12))<1e-10);
  assert.throws(()=>decodeAngles([NaN],pitch),/无效/);
  assert.ok(faceBounds(landmarks(),1280,720).width>200);
  assert.equal(faceBounds([],1280,720),null);
});
test('direct display projection uses physical camera position and preserves the same target when the head moves',()=>{
  const display={widthCm:33,heightCm:21,cameraXCm:16.5,cameraYCm:-1.5,viewport:{width:1280,height:800}};
  const calibration=new RayCalibration();
  const target=[0.8,0.2];
  const hit=[target[0]*display.widthCm-display.cameraXCm,target[1]*display.heightCm-display.cameraYCm];
  const reference=eyeOrigin({scale:24,eye:[0,0.1]},1280,800);
  assert.deepEqual(projectToDisplay({yaw:0,pitch:0},[0,12,50],display),[0.5,0.5]);
  for(const origin of [[-5,8,44],[5,4,55],[3,7,63]]) {
    const vector=[hit[0]-origin[0],hit[1]-origin[1],-origin[2]];
    const gaze={yaw:Math.atan2(-vector[0],-vector[2]),pitch:Math.asin(-vector[1]/Math.hypot(...vector))};
    const pose={scale:1280/origin[2],eye:origin.slice(0,2).map(value=>value/origin[2])};
    const ray=projectToDisplay(gaze,eyeOrigin(pose,1280,800),display);
    const before=projectToDisplay(gaze,reference,display);
    const pair=calibration.pair({ray,before},display.viewport);
    assert.ok(Math.hypot(pair.prediction.x-1024,pair.prediction.y-160)<1e-8);
    assert.ok(Math.hypot(pair.before.x-1024,pair.before.y-160)>40);
  }
});

test('moving the irises cannot shift the inferred eye origin',()=>{
  const geometry=new FaceGeometry(template);
  const points=landmarks();
  const reference=geometry.estimate(points,1280,720);
  points[468][0]+=20;
  points[473][1]-=30;
  assert.deepEqual(geometry.estimate(points,1280,720).eye,reference.eye);
});
test('affine screen calibration freezes after nine points; comparisons share the same fitted mapping',()=>{
  const model=new RayCalibration();
  for(const p of pointsFor('calibration',1200,800))for(let i=0;i<8;i++)model.addData([(p.x-600)/1000,(p.y-400)/1000],[p.x,p.y]);
  const before=model.fit({width:1200,height:800,requiredTargets:9});
  const pair=model.pair({ray:[0.2,-0.1],before:[0.3,-0.1]});
  assert.ok(Math.hypot(pair.prediction.x-800,pair.prediction.y-300)<2);
  assert.ok(pair.before.x-pair.prediction.x>99);
  assert.equal(model.addData([0,0],[600,400]),false);
  assert.deepEqual(model.diagnostics(),before);
  assert.equal(model.predict([NaN,0]),null);
  model.init();assert.equal(model.predict([0,0]),null);
});
test('stale, future or nonfinite frames fail the 250 ms freshness limit',()=>{
  assert.equal(freshResult(100,350),true);
  assert.equal(freshResult(100,351),false);
  assert.equal(freshResult(100,99),false);
  assert.equal(freshResult(NaN,100),false);
});
test('paired comparison uses identical valid frames, includes regressions and exports pose columns',()=>{
  const samples=[{valid:true,x:60,y:50,beforeX:70,beforeY:50,targetId:1,targetX:50,targetY:50},{valid:true,x:1000,y:1000,beforeX:null,beforeY:null,targetId:1,targetX:50,targetY:50},{valid:false,x:null,y:null,beforeX:50,beforeY:50,targetId:1,targetX:50,targetY:50}];
  const result=pairedSummaries(samples,[{id:1,x:50,y:50}],100,100);
  assert.equal(result.pairedSamples,1);
  assert.equal(result.before.medianErrorPx,20);
  assert.equal(result.after.medianErrorPx,10);
  assert.equal(result.medianImprovementPct,50);
  const csv=samplesToCsv([{...samples[0],headYawDeg:-10,distanceRatio:1.2}]);
  assert.ok(csv.includes('headYawDeg'));assert.ok(csv.includes('beforeErrorPx'));assert.ok(csv.includes('1.2,-10'));
});
