// Real weights and backend checks, without requesting any camera.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {writeFile,mkdir,readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const bundled=path.join(path.dirname(path.dirname(process.execPath)),'node_modules/playwright/index.mjs');
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE||bundled).href);
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const base=process.env.GAZE_LAB_URL||'http://localhost:8765/';
try {
  const page=await browser.newPage();
  const requests=[],errors=[];
  page.on('request',request=>requests.push(request.url()));page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{navigator.mediaDevices.getUserMedia=()=>{throw new Error('This test must not request a camera');};});
  await page.route('**/qa-portrait.jpg',route=>route.fulfill({path:path.resolve('tests/fixtures/portrait.jpg'),contentType:'image/jpeg'}));
  await page.goto(base);
  const result=await page.evaluate(async()=>{
    const script=document.createElement('script');script.src='./vendor/webgazer.js';
    await new Promise((resolve,reject)=>{script.onload=resolve;script.onerror=reject;document.head.append(script);});
    const wg=window.webgazer;wg.params.faceMeshSolutionPath='./vendor/mediapipe/face_mesh';
    const tracker=wg.getTracker();await tracker.init();await tracker.detector.faceMeshSolution.setOptions({refineLandmarks:true});
    const image=new Image();image.src='./qa-portrait.jpg';await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;canvas.getContext('2d').drawImage(image,0,0);
    await tracker.getEyePatches(image,canvas,canvas.width,canvas.height);const landmarks=tracker.getPositions();
    const {PretrainedGaze}=await import('./pretrained-gaze.mjs');
    const {FaceGeometry,projectGaze}=await import('./face-geometry.mjs');
    const template=await(await fetch('./vendor/compensation/canonical-face.json')).json();
    const geometry=new FaceGeometry(template),pose=geometry.estimate(landmarks,canvas.width,canvas.height);
    geometry.beginReference();for(let i=0;i<20;i++)geometry.capture(pose);geometry.finishReference();
    const runs=[];
    for(const forceWasm of [true,false]) {
      const model=new PretrainedGaze(),started=performance.now();const info=await model.init({forceWasm});const loadMs=performance.now()-started;
      const predictions=[];for(let i=0;i<3;i++)predictions.push(await model.predict(canvas,landmarks));
      const inFlight=model.predict(canvas,landmarks);
      const concurrent=await model.predict(canvas,landmarks);
      const pending=inFlight.then(()=>false,()=>true);model.close();
      const cancelled=await pending;
      const afterClose=await model.predict(canvas,landmarks);
      runs.push({forceWasm,info,loadMs,predictions,concurrent,cancelled,afterClose,ray:projectGaze(predictions[0].angles,pose,geometry.reference)});
    }
    return {landmarks:landmarks.length,poseError:pose?.residual,runs};
  });
  assert.equal(result.landmarks,478);assert.ok(result.poseError<0.25);
  assert.equal(result.runs[0].info.provider,'wasm');
  for(const item of result.runs) {
    assert.ok(item.predictions.every(p=>p&&Object.values(p.angles).every(Number.isFinite)));
    assert.ok(item.ray.every(Number.isFinite));assert.equal(item.concurrent,null);assert.equal(item.cancelled,true);assert.equal(item.afterClose,null);
  }
  const a=result.runs[0].predictions[0].angles,b=result.runs[1].predictions[0].angles;
  assert.ok(Math.abs(a.yaw-b.yaw)<1e-4&&Math.abs(a.pitch-b.pitch)<1e-4);
  assert.deepEqual(errors,[]);assert.ok(requests.every(url=>new URL(url).origin===new URL(base).origin));
  await page.close();

  const missing=await browser.newPage();await missing.route('**/mobileone_s0_gaze.onnx',route=>route.abort());await missing.goto(base);
  const rejected=await missing.evaluate(async()=>{
    const {PretrainedGaze}=await import('./pretrained-gaze.mjs');const model=new PretrainedGaze();
    try {await model.init({forceWasm:true});return false;}catch{return true;}finally{model.close();}
  });
  assert.equal(rejected,true);await missing.close();

  const fallback=await browser.newPage();
  await fallback.route('**/gaze-worker.mjs',async route=>route.fulfill({contentType:'text/javascript',body:`Object.defineProperty(navigator,'gpu',{configurable:true,value:{requestAdapter:async()=>null}});\n`+await readFile('dist/gaze-worker.mjs','utf8')}));
  await fallback.goto(base);
  const fallbackProvider=await fallback.evaluate(async()=>{
    // Worker route injects a WebGPU failure while preserving real WASM weights.
    const {PretrainedGaze}=await import('./pretrained-gaze.mjs');const model=new PretrainedGaze();
    try{return(await model.init()).provider;}finally{model.close();}
  });
  assert.equal(fallbackProvider,'wasm');await fallback.close();
  await mkdir('qa',{recursive:true});await writeFile('qa/pretrained-checks.json',JSON.stringify({result,localRequests:requests.length,errors,missingModelRejected:rejected,webgpuFailureFallback:fallbackProvider},null,2));
  console.log(JSON.stringify({test:'real weights, WASM/WebGPU parity, geometry, no camera, one in-flight frame, cancellation, missing model and WebGPU failure fallback',pass:true,result},null,2));
} finally {await browser.close();}
