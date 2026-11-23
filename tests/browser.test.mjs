// Development-only integration checks. No test mode is added to the product.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const bundledPlaywright = path.join(path.dirname(path.dirname(process.execPath)), 'node_modules', 'playwright', 'index.mjs');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : pathToFileURL(bundledPlaywright).href);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const base = process.env.GAZE_LAB_URL || 'http://localhost:8765/';
const qa = path.resolve('qa');
await mkdir(qa, { recursive: true });
const results = [];

const mockEngine = `
let stream; let timer;
const state = { detected: true, training: [], frames: 0, invalidEvery: 0, dx: 30, dy: 40,mode:'natural',referenceSamples:0,referencing:false,modelUnavailable:false };
window.testEye = state;
const connectionId = Number(window.frameElement.dataset.connectionId);
window.gazeEngine = {
  async startEngine(id,options={}) {
    const available=!new URL(parent.location.href).searchParams.has('missing-model');
    state.mode=available?(options.mode||'natural'):'precision';
    stream = await navigator.mediaDevices.getUserMedia({video:true,audio:false});
    state.stream = stream;
    const preview = document.createElement('div'); preview.textContent='自动化测试 · 模拟输入';preview.style.cssText='color:#a6bfad;padding:24px;font-size:12px';document.body.append(preview);
    // Drive the mock from the same clock as the target protocol.
    timer=parent.setInterval(()=>{
      state.frames++;
      const detected=state.detected && !state.modelUnavailable && !(state.invalidEvery && state.frames % state.invalidEvery === 0);
      if(detected&&state.referencing)state.referenceSamples++;
      const target=parent.document.getElementById('targetDot');
      const x=parseFloat(target.style.left)||400;const y=parseFloat(target.style.top)||300;
      const ratio=state.ratio??1.15;
      const dx=state.distanceBias?(ratio-1)*450:state.dx;
      const dy=state.distanceBias?(ratio-1)*250:state.dy;
      const prediction=detected&&(state.training.length||state.display)?{x:x+dx,y:y+dy}:null;
      const quality={reason:detected?'good':state.modelUnavailable?'model-unavailable':'blink',referenceSamples:state.referenceSamples,pose:{distanceRatio:ratio,yaw:12,pitch:-5,roll:8,fitError:0.04},latencyMs:50,modelId:'mobilegaze-mobileone-s0-gaze360',provider:'wasm',before:prediction?{x:x+dx*2,y:y+dy*2}:null,compensation:{available:!state.modelUnavailable},frameId:state.frames};
      const info=state.mode==='natural'?quality:{frameId:state.frames};
      parent.gazeLabFrame(prediction,detected,connectionId,info);
      if(state.duplicateFrames)parent.gazeLabFrame(prediction,detected,connectionId,info);
    },100);
    return {width:640,height:480,frameRate:30,compensation:{available,provider:'wasm',error:available?null:'Test missing model'}};
  },
  configureMode(next){state.mode=next;this.clearTraining();},
  setScreenGeometry(profile){state.display=profile;this.clearTraining();},
  beginReference(){state.referencing=true;state.referenceSamples=0;},
  finishReference(){state.referencing=false;return {referenceSamples:state.referenceSamples,reference:{scale:20,eye:[0,0]}};},
  train(x,y) { state.training.push({x,y}); return true; },
  finalizeTraining() {
    const counts = new Map();
    for (const point of state.training) { const key=point.x+','+point.y; counts.set(key,(counts.get(key)||0)+1); }
    return {targetCount:counts.size,retainedSamples:state.training.length,fitCount:1,frozen:true};
  },
  clearTraining() { state.training=[];state.referencing=false; },
  stopEngine() { parent.clearInterval(timer);stream?.getTracks().forEach(t=>t.stop()); }
};
parent.gazeLabEngineReady(connectionId);
`;

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text()); });
  return errors;
}

async function connected(page) {
  await page.locator('#connectBtn').click();
  try {
    await page.waitForFunction(() => document.querySelector('#cameraState').textContent === '已连接' || !document.querySelector('#connectBtn').disabled, null, { timeout: 45000 });
    assert.equal(await page.locator('#cameraState').innerText(), '已连接');
  } catch (error) {
    console.log(JSON.stringify({ failure: 'connect', state: await page.locator('#cameraState').innerText(), notice: await page.locator('#notice').innerText(), frames: page.frames().map(f => f.url()) }));
    throw error;
  }
}

try {
  // Real pinned code + real local WASM + a synthetic camera (no person's camera).
  const real = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  const realErrors = collectErrors(real);
  const requests = [];
  real.on('request', request => requests.push(request.url()));
  await real.route('**/qa-portrait.jpg',route=>route.fulfill({path:path.resolve('tests/fixtures/portrait.jpg'),contentType:'image/jpeg'}));
  await real.addInitScript(()=>{
    navigator.mediaDevices.getUserMedia=async()=>{
      const picture=new Image();picture.src='./qa-portrait.jpg';await picture.decode();
      const canvas=document.createElement('canvas');canvas.width=picture.naturalWidth;canvas.height=picture.naturalHeight;
      const context=canvas.getContext('2d');
      context.drawImage(picture,0,0);
      let n=0;
      setInterval(()=>{
        context.drawImage(picture,0,0);context.fillStyle=n++%2?'black':'white';context.fillRect(0,0,2,2);
      },67);
      return canvas.captureStream(15);
    };
  });
  await real.goto(base);
  await real.screenshot({ path: path.join(qa, 'dashboard.png'), fullPage: true });
  await connected(real);
  const realEngine = real.frames().find(frame => frame.url().endsWith('/engine.html'));
  assert.equal(await realEngine.evaluate(() => window.webgazer.getRegression()[0].name), 'precision-calibration-ridge');
  await real.locator('#practiceBtn').click();
  await real.waitForFunction(()=>document.fullscreenElement&&document.querySelector('#poseDistance').textContent.endsWith(' ×'),null,{timeout:12000});
  const realFrameRate=parseInt(await real.locator('#frameRate').innerText(),10);
  assert.ok(realFrameRate>0&&realFrameRate<=16,`Observed ${realFrameRate} inference callbacks per second from a 15 fps video`);
  await real.locator('#overlayExitBtn').click();
  await real.waitForFunction(()=>!document.fullscreenElement);
  await real.evaluate(()=>{
    // Keep the UI watchdog quiet while pausing the camera loop for manual fixture calls.
    const id=Number(document.querySelector('iframe').dataset.connectionId);
    window.manualFixtureHeartbeat=setInterval(()=>window.gazeLabFrame(null,false,id),1000);
  });
  const irisCheck=await realEngine.evaluate(async()=>{
    const wg=window.webgazer;
    wg.pause();
    await new Promise(resolve=>setTimeout(resolve,250));
    const picture=new Image(); picture.src='./qa-portrait.jpg'; await picture.decode();picture.currentTime=1;
    const canvas=document.createElement('canvas');canvas.width=picture.naturalWidth;canvas.height=picture.naturalHeight;
    canvas.getContext('2d').drawImage(picture,0,0);
    window.gazeEngine.configureMode('precision');
    const tracker=wg.getTracker();
    const eyes=await tracker.getEyePatches(picture,canvas,canvas.width,canvas.height);
    const {FaceGeometry}=await import('./face-geometry.mjs');
    const template=await(await fetch('./vendor/compensation/canonical-face.json')).json();
    const pose=new FaceGeometry(template).estimate(tracker.getPositions(),canvas.width,canvas.height);
    const {irisFeatures}=await import('./eye-features.mjs');
    const result={landmarks:tracker.getPositions()?.length,features:eyes?.gazeVector?.length,finite:eyes?.gazeVector?.every(Number.isFinite),poseError:pose?.residual,reason:irisFeatures(tracker.getPositions()).reason};
    wg.resume();
    return result;
  });
  assert.equal(irisCheck.landmarks,478);
  assert.equal(irisCheck.features,332,JSON.stringify(irisCheck));
  assert.equal(irisCheck.finite,true);
  assert.ok(irisCheck.poseError<0.25);
  results.push({test:'real local refined iris model extracts 478 landmarks and 332 features from official portrait fixture',pass:true,irisCheck});
  const realCalibration=await realEngine.evaluate(async()=>{
    const wg=window.webgazer;wg.pause();await new Promise(resolve=>setTimeout(resolve,150));
    const engine=window.gazeEngine;engine.configureMode('natural');engine.beginReference();
    const picture=new Image();picture.src='./qa-portrait.jpg';await picture.decode();
    const canvas=document.createElement('canvas');canvas.width=picture.naturalWidth;canvas.height=picture.naturalHeight;canvas.getContext('2d').drawImage(picture,0,0);
    const tracker=wg.getTracker();let sequence=100;
    const next=async()=>{picture.currentTime=++sequence;return tracker.getEyePatches(picture,canvas,canvas.width,canvas.height);};
    for(let i=0;i<20;i++)await next();
    const reference=engine.finishReference();let accepted=0,duplicates=0;
    // A stationary photo checks data flow and freezing; it is not an accuracy test.
    for(const y of [108,540,972])for(const x of [144,720,1296]) {
      let count=0;
      for(let attempt=0;attempt<16&&count<8;attempt++) {
        await next();if(engine.train(x,y)){count++;accepted++;if(!engine.train(x,y))duplicates++;}
      }
      if(count<8)throw new Error('Real pipeline could not collect eight fresh frames');
    }
    const model=engine.finalizeTraining({width:1440,height:1080,requiredTargets:9});
    await next();const frozen=!engine.train(720,540);
    const after=engine.trainingDiagnostics();engine.configureMode('precision');wg.resume();
    return {referenceSamples:reference.referenceSamples,accepted,duplicates,model,after,frozen};
  });
  assert.ok(realCalibration.referenceSamples>=12);
  assert.equal(realCalibration.accepted,72);assert.equal(realCalibration.duplicates,72);
  assert.equal(realCalibration.model.targetCount,9);assert.equal(realCalibration.model.frozen,true);
  assert.equal(realCalibration.after.retainedSamples,72);assert.equal(realCalibration.frozen,true);
  results.push({test:'real frozen-image pipeline collects reference and fresh calibration frames, rejects duplicates and freezes after fitting',pass:true,realCalibration});
  const retentionCheck = await realEngine.evaluate(() => {
    const wg = window.webgazer;
    const stock = new wg.reg.RidgeReg();
    const corrected = wg.getRegression()[0];
    function eyes(x, y, sample) {
      const width = 40, height = 24;
      const patch = new ImageData(width, height);
      for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
        const cx = width * (0.25 + x * 0.5), cy = height * (0.2 + y * 0.6);
        const value = Math.round(220 - 180 * Math.exp(-((px - cx) ** 2 + (py - cy) ** 2) / 18) + Math.sin(px * 7 + py * 11 + sample) * 0.5);
        const offset = (py * width + px) * 4;
        patch.data.set([value, value, value, 255], offset);
      }
      const eye = {patch, width, height, imagex:0, imagey:0};
      return {left:eye,right:eye};
    }
    for (const y of [0.1, 0.5, 0.9]) for (const x of [0.1, 0.5, 0.9]) {
      for (let i = 0; i < 20; i++) {
        const features = eyes(x, y, i);
        stock.addData(features, [x * 1440, y * 1080], 'click');
        corrected.addData(features, [x * 1440, y * 1080], 'click');
      }
    }
    const diagnostics = corrected.fit({width:1440,height:1080});
    const top = corrected.predict(eyes(0.5,0.1,0));
    const bottom = corrected.predict(eyes(0.5,0.9,0));
    const result = { stockSamples: stock.getData().length, stockOnlyBottomRow: stock.getData().every(sample => sample.screenPos[1] === 972), corrected: diagnostics, top, bottom };
    corrected.init();
    return result;
  });
  assert.equal(retentionCheck.stockSamples, 50);
  assert.equal(retentionCheck.stockOnlyBottomRow, true);
  assert.equal(retentionCheck.corrected.targetCount, 9);
  assert.equal(retentionCheck.corrected.retainedSamples, 180);
  assert.ok(retentionCheck.top.y < 360);
  assert.ok(retentionCheck.bottom.y > 720);
  results.push({test:'real SDK reproduces stock bottom-row data loss; corrected regression keeps 180 samples and all rows',pass:true,retentionCheck});
  await real.evaluate(()=>clearInterval(window.manualFixtureHeartbeat));
  await real.waitForTimeout(1800);
  assert.equal(await real.locator('#calibrateBtn').isEnabled(), true);
  assert.ok(parseInt(await real.locator('#frameRate').innerText(), 10) > 0);
  const stopped = await real.evaluate(() => {
    const frame = document.querySelector('iframe');
    const tracks = frame.contentDocument.getElementById('webgazerVideoFeed').srcObject.getTracks();
    document.querySelector('#stopBtn').click();
    return tracks.map(track => track.readyState);
  });
  assert.ok(stopped.every(state => state === 'ended'));
  assert.ok(requests.every(url => new URL(url).origin === new URL(base).origin), 'real engine must use only local requests');
  assert.deepEqual(realErrors, []);
  results.push({ test: 'real local model, 15 fps synthetic video in fullscreen with unique frames, and track release', pass: true, realFrameRate, localRequests: requests.length });
  await real.close();

  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, acceptDownloads: true });
  const errors = collectErrors(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const track = {readyState:'live',stop(){this.readyState='ended';}};
      return {getTracks:()=>[track],getVideoTracks:()=>[track]};
    };
  });
  await page.route('**/engine-boot.mjs', route => route.fulfill({ contentType: 'text/javascript', body: mockEngine }));
  await page.clock.install();
  await page.goto(base);
  await page.locator('#trackingMode').selectOption('precision');
  await connected(page);
  const camera = () => page.frames().find(frame => frame.url().endsWith('/engine.html'));
  await camera().evaluate(() => { window.testEye.detected = false; });
  await page.locator('#calibrateBtn').click();
  await page.clock.runFor(4000);
  assert.equal(await page.locator('#protocolCounter').innerText(), '1 / 16');
  assert.equal(await camera().evaluate(() => window.testEye.training.length), 0);
  await camera().evaluate(() => { window.testEye.detected = true; });
  await page.clock.runFor(1600);
  await page.screenshot({ path: path.join(qa, 'calibration.png') });
  await page.clock.runFor(55000);
  for(let extra=0;extra<30000&&!(await page.locator('#practiceBtn').isEnabled());extra+=1000)await page.clock.runFor(1000);
  if (!(await page.locator('#practiceBtn').isEnabled())) console.log(JSON.stringify({failure:'calibration',notice:await page.locator('#notice').innerText(),counter:await page.locator('#protocolCounter').innerText(),status:await page.locator('#protocolStatus').innerText(),training:await camera()?.evaluate(()=>window.testEye.training.length)}));
  assert.equal(await page.locator('#practiceBtn').isEnabled(), true);
  const trainingCount = await camera().evaluate(() => window.testEye.training.length);
  assert.ok(trainingCount >= 16 * 12);
  assert.equal(await camera().evaluate(() => new Set(window.testEye.training.map(p => p.x + ',' + p.y)).size), 16);
  await page.locator('#practiceBtn').click();
  await page.clock.runFor(500);
  assert.equal(await page.locator('#gazeDot').isVisible(), true);
  await page.mouse.move(50, 150);
  await page.mouse.click(50, 150);
  await page.clock.runFor(300);
  assert.equal(await camera().evaluate(() => window.testEye.training.length), trainingCount);
  await page.locator('#overlayExitBtn').click();
  await camera().evaluate(() => { window.testEye.invalidEvery = 5; });
  await page.locator('#baselineBtn').click();
  await page.clock.runFor(1200);
  assert.equal(await page.locator('#gazeDot').isVisible(), false);
  await page.clock.runFor(27000);
  assert.equal(await page.locator('#metricMedian').innerText(), '50 px');
  assert.equal(await page.locator('#motionBtn').isEnabled(), true);
  await camera().evaluate(() => { window.testEye.dx = 100; window.testEye.dy = 0; });
  await page.locator('#motionBtn').click();
  await page.clock.runFor(28000);
  assert.equal(await page.locator('#metricMedian').innerText(), '100 px');
  assert.equal(await camera().evaluate(() => window.testEye.training.length), trainingCount);
  await page.screenshot({ path: path.join(qa, 'results-synthetic.png'), fullPage: true });

  const jsonDownload = page.waitForEvent('download');
  await page.locator('#exportJsonBtn').click();
  await (await jsonDownload).saveAs(path.join(qa, 'results-synthetic.json'));
  const report = JSON.parse(await readFile(path.join(qa, 'results-synthetic.json'), 'utf8'));
  assert.equal(report.appVersion, '1.4.1');
  assert.equal(report.calibrations[0].model.targetCount, 16);
  assert.equal(report.calibrations[0].model.retainedSamples, trainingCount);
  assert.equal(report.rounds.length, 2);
  for (const round of report.rounds) {
    assert.equal(round.trainingSamplesBefore, round.trainingSamplesAfter);
    assert.equal(round.summary.targetsWithData, 9);
    assert.ok(round.summary.validPredictionRate > 0.75 && round.summary.validPredictionRate < 0.85);
    assert.equal(round.targets.length, 9);
    assert.ok(round.targets.every(t => !report.calibrations[0].targets.some(c => c.x === t.x && c.y === t.y)));
  }
  const csvDownload = page.waitForEvent('download');
  await page.locator('#exportCsvBtn').click();
  await (await csvDownload).saveAs(path.join(qa, 'results-synthetic.csv'));
  const csv = await readFile(path.join(qa, 'results-synthetic.csv'), 'utf8');
  assert.ok(csv.startsWith('\uFEFFroundId,'));
  assert.equal(csv.split('\r\n').length, 1 + report.rounds.flatMap(round => round.samples).length);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.runFor(100);
  await page.waitForFunction(()=>document.querySelector('#practiceBtn').disabled,null,{polling:50,timeout:3000});
  assert.equal(await page.locator('#practiceBtn').isEnabled(), false);
  assert.ok((await page.locator('#notice').innerText()).includes('重新校准'));
  assert.equal(await page.locator('#exportJsonBtn').isEnabled(), true);
  await page.locator('#calibrateBtn').click();
  await page.clock.runFor(800);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#protocolOverlay').isVisible(), false);
  assert.equal(await page.locator('#practiceBtn').isEnabled(), false);
  await page.locator('#stopBtn').click();
  await connected(page);
  assert.equal(await camera().evaluate(() => window.testEye.training.length), 0);
  await page.locator('#stopBtn').click();
  assert.deepEqual(errors, []);
  results.push({ test: 'complete protocol, frozen training, scores, exports, resize, cancel and restart', pass: true, trainingCount, recordedSamples: report.rounds.flatMap(round => round.samples).length });
  await page.close();

  const natural=await browser.newPage({viewport:{width:1440,height:1080},acceptDownloads:true});
  const naturalErrors=collectErrors(natural);
  await natural.addInitScript(()=>{
    navigator.mediaDevices.getUserMedia=async()=>{const track={readyState:'live',stop(){this.readyState='ended';}};return {getTracks:()=>[track],getVideoTracks:()=>[track]};};
  });
  await natural.route('**/engine-boot.mjs',route=>route.fulfill({contentType:'text/javascript',body:mockEngine}));
  let deviceReads=0;
  await natural.route('**/device-info',route=>{
    deviceReads++;
    return route.fulfill({json:{displays:[{primary:true,widthCm:33,heightCm:21,resolutionWidth:2560,resolutionHeight:1600},
      {primary:false,widthCm:53,heightCm:30,resolutionWidth:1920,resolutionHeight:1080}]}});
  });
  await natural.clock.install();await natural.goto(base);await connected(natural);
  const naturalCamera=()=>natural.frames().find(f=>f.url().endsWith('/engine.html'));
  assert.equal(deviceReads,0);
  await natural.locator('#readDeviceBtn').click();
  await natural.waitForFunction(()=>document.querySelector('#sizeSource').value==='detected');
  assert.equal(deviceReads,1);
  await natural.locator('#displayChoice').selectOption('1');
  assert.match(await natural.locator('#deviceSummary').innerText(),/53.0 × 30.0/);
  await natural.locator('#displayChoice').selectOption('0');
  await natural.locator('#practiceBtn').click();
  await natural.waitForFunction(()=>Boolean(document.fullscreenElement));
  await natural.locator('#gazeDot').waitFor({state:'visible',timeout:3000});
  assert.equal(await naturalCamera().evaluate(()=>window.testEye.training.length),0);
  await naturalCamera().evaluate(()=>{window.testEye.dx=-3000;});
  await natural.waitForFunction(()=>document.querySelector('#protocolStatus').textContent.includes('超出屏幕'));
  assert.equal(await natural.locator('#gazeDot').isVisible(),false);
  await naturalCamera().evaluate(()=>{window.testEye.dx=30;window.testEye.duplicateFrames=true;});
  await natural.locator('#overlayExitBtn').click();
  await natural.waitForFunction(()=>!document.fullscreenElement);
  await natural.locator('#testCount').selectOption('16');
  await natural.locator('#motionKind').selectOption('lateral');
  await natural.locator('#motionBtn').click();
  await natural.clock.runFor(49500);
  await natural.waitForFunction(()=>!document.fullscreenElement);
  assert.match(await natural.locator('#resultContext').innerText(),/免校准.*左右平移.*16 点/);
  assert.equal(await naturalCamera().evaluate(()=>window.testEye.training.length),0);
  await natural.locator('#testCount').selectOption('9');
  await naturalCamera().evaluate(()=>{window.testEye.detected=false;});
  await natural.locator('#calibrateBtn').click();await natural.clock.runFor(3000);
  assert.equal(await natural.locator('#protocolLabel').innerText(),'记录参考坐姿');
  assert.equal(await naturalCamera().evaluate(()=>window.testEye.training.length),0);
  await naturalCamera().evaluate(()=>{window.testEye.detected=true;});
  await natural.clock.runFor(1200);await natural.screenshot({path:path.join(qa,'natural-reference.png')});
  await natural.clock.runFor(36000);
  await natural.waitForFunction(()=>!document.fullscreenElement);
  assert.match(await natural.locator('#notice').innerText(),/9 点校准完成/);
  const naturalTraining=await naturalCamera().evaluate(()=>window.testEye.training.length);
  assert.ok(naturalTraining>=9*8);
  assert.equal(await naturalCamera().evaluate(()=>new Set(window.testEye.training.map(p=>p.x+','+p.y)).size),9);
  assert.equal(await natural.locator('#poseDistance').innerText(),'1.15 ×');
  assert.equal(await natural.locator('#poseYaw').innerText(),'+12.0°');
  await natural.locator('#baselineBtn').click();await natural.clock.runFor(28500);
  assert.equal(await natural.locator('#metricMedian').innerText(),'50 px');
  assert.match(await natural.locator('#compensationComparison').innerText(),/固定双眼位置 100 px.*实时更新位置 50 px/);
  await natural.locator('#motionKind').selectOption('roll');
  await naturalCamera().evaluate(()=>{window.testEye.dx=15;window.testEye.dy=20;});
  await natural.locator('#motionBtn').click();await natural.clock.runFor(28500);
  assert.equal(await natural.locator('#metricMedian').innerText(),'25 px');
  await natural.screenshot({path:path.join(qa,'natural-results.png'),fullPage:true});
  const naturalDownload=natural.waitForEvent('download');await natural.locator('#exportJsonBtn').click();
  await(await naturalDownload).saveAs(path.join(qa,'natural-results.json'));
  const naturalReport=JSON.parse(await readFile(path.join(qa,'natural-results.json'),'utf8'));
  assert.equal(naturalReport.calibrations[0].trackingMode,'natural');
  assert.ok(naturalReport.calibrations[0].reference.referenceSamples>=12);
  assert.equal(naturalReport.calibrations[0].protocol.minCalibrationSamples,8);
  const [direct,baseline,motion]=naturalReport.rounds;
  assert.equal(direct.motionKind,'lateral');
  assert.equal(direct.targets.length,16);
  assert.equal(direct.calibrationId,null);
  assert.equal(direct.trainingSamplesBefore,0);
  assert.equal(direct.trainingSamplesAfter,0);
  assert.equal(direct.display.widthCm,33);
  assert.equal(direct.display.cameraYCm,-1.5);
  assert.equal(direct.display.screenSizeSource,'detected');
  assert.equal(motion.motionKind,'roll');
  for(const round of [baseline,motion]) {
    assert.equal(round.trainingSamplesBefore,naturalTraining);assert.equal(round.trainingSamplesAfter,naturalTraining);
    assert.equal(round.compensationComparison.medianImprovementPct,50);
    assert.ok(round.samples.filter(s=>s.valid).every(s=>s.distanceRatio===1.15&&s.headYawDeg===12&&s.beforeX!==null));
  }
  for(const round of naturalReport.rounds) {
    assert.equal(round.samples.length,new Set(round.samples.map(s=>s.frameId)).size);
    assert.equal(round.summary.targetsWithData,round.targets.length);
    assert.ok(round.summary.predictionHz>=9.5&&round.summary.predictionHz<=10.25,JSON.stringify(round.summary));
  }
  await natural.locator('#calibrationCount').selectOption('16');
  await natural.locator('#calibrateBtn').click();
  await natural.clock.runFor(53000);
  await natural.waitForFunction(()=>!document.fullscreenElement);
  assert.match(await natural.locator('#notice').innerText(),/16 点校准完成/);
  assert.equal(await naturalCamera().evaluate(()=>new Set(window.testEye.training.map(p=>p.x+','+p.y)).size),16);
  const beforeDepthTraining=await naturalCamera().evaluate(()=>window.testEye.training.length);
  await naturalCamera().evaluate(()=>{window.testEye.distanceBias=true;window.testEye.ratio=1;});
  await natural.locator('#distanceCalibrateBtn').click();
  await natural.clock.runFor(2000);
  assert.equal(await natural.locator('#protocolCounter').innerText(),'1 / 6');
  await naturalCamera().evaluate(()=>{window.testEye.ratio=0.84;});
  await natural.clock.runFor(9300);
  assert.equal(await natural.locator('#protocolCounter').innerText(),'4 / 6');
  await naturalCamera().evaluate(()=>{window.testEye.ratio=1.16;});
  await natural.clock.runFor(9500);
  await natural.waitForFunction(()=>!document.fullscreenElement);
  assert.match(await natural.locator('#notice').innerText(),/近／远校准完成/);
  await natural.locator('#motionKind').selectOption('distance');
  await natural.locator('#motionBtn').click();
  await natural.clock.runFor(28400);
  await natural.waitForFunction(()=>!document.fullscreenElement);
  assert.match(await natural.locator('#distanceComparison').innerText(),/原几何 82 px.*近／远校准后 [01] px/);
  assert.equal(await naturalCamera().evaluate(()=>window.testEye.training.length),beforeDepthTraining);
  await natural.locator('#distanceCalibrateBtn').click();
  await natural.clock.runFor(500);
  await natural.locator('#overlayExitBtn').click();
  assert.match(await natural.locator('#distanceCalibrationStatus').innerText(),/距离修正已启用/);
  await natural.locator('#cameraPlacement').selectOption('bottom');
  assert.equal(await naturalCamera().evaluate(()=>window.testEye.training.length),0);
  assert.equal(await natural.locator('#distanceCalibrateBtn').isEnabled(),false);
  assert.equal(await natural.locator('#exportJsonBtn').isEnabled(),true);
  await naturalCamera().evaluate(()=>{window.testEye.modelUnavailable=true;});await natural.clock.runFor(300);
  assert.equal(await natural.locator('#modelFallback').isVisible(),true);
  await natural.locator('#fallbackBtn').click();
  assert.equal(await natural.locator('#trackingMode').inputValue(),'precision');
  assert.equal(await natural.locator('#practiceBtn').isEnabled(),false);
  assert.equal(await natural.locator('#exportJsonBtn').isEnabled(),true);
  await natural.locator('#stopBtn').click();assert.deepEqual(naturalErrors,[]);
  results.push({test:'natural reference, nine-point calibration, same-frame comparison, pose export and runtime fallback',pass:true,trainingCount:naturalTraining});
  await natural.close();

  const fallback=await browser.newPage();
  await fallback.addInitScript(()=>{navigator.mediaDevices.getUserMedia=async()=>({getTracks:()=>[],getVideoTracks:()=>[]});});
  await fallback.route('**/engine-boot.mjs',route=>route.fulfill({contentType:'text/javascript',body:mockEngine}));
  await fallback.goto(base+'?missing-model');await connected(fallback);
  assert.equal(await fallback.locator('#trackingMode').inputValue(),'precision');
  assert.equal(await fallback.locator('#modelFallback').isVisible(),true);
  assert.equal(await fallback.locator('#calibrateBtn').isEnabled(),true);
  await fallback.locator('#stopBtn').click();await fallback.close();
  results.push({test:'unavailable pretrained model preserves the precision mode',pass:true});

  for (const [name, expected] of [['NotAllowedError', '权限'], ['NotReadableError', '占用'], ['NotFoundError', '没有找到']]) {
    const failure = await browser.newPage();
    await failure.route('**/engine-boot.mjs', route => route.fulfill({ contentType: 'text/javascript', body: mockEngine }));
    await failure.addInitScript(name => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Test camera failure', name); }; }, name);
    await failure.goto(base);
    await failure.locator('#connectBtn').click();
    await failure.waitForFunction(() => !document.querySelector('#connectBtn').disabled);
    assert.ok((await failure.locator('#notice').innerText()).includes(expected));
    assert.equal(await failure.locator('iframe').count(), 0);
    assert.equal(await failure.locator('#calibrateBtn').isEnabled(), false);
    results.push({ test: name, pass: true });
    await failure.close();
  }

  const missing = await browser.newPage();
  await missing.route('**/vendor/webgazer.js', route => route.abort());
  await missing.goto(base);
  await missing.locator('#connectBtn').click();
  await missing.waitForFunction(() => !document.querySelector('#connectBtn').disabled);
  assert.ok((await missing.locator('#notice').innerText()).includes('未能加载'));
  results.push({ test: 'missing local library', pass: true });
  await missing.close();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(base);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await mobile.screenshot({ path: path.join(qa, 'mobile.png'), fullPage: true });
  results.push({ test: 'narrow layout without horizontal overflow', pass: true });
  await mobile.close();
  await writeFile(path.join(qa, 'browser-checks.json'), JSON.stringify({ syntheticDataOnly: true, results }, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
