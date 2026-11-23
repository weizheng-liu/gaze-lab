import { PROTOCOL,NATURAL_PROTOCOL,pairedSummaries, pointsFor, shuffled, TargetClock, finitePrediction, summarize, trainingAllowed, samplesToCsv, DisplayStabilizer } from './core.mjs';
import {MIN_DISTANCE_SAMPLES,distanceTargets,distanceSide,fitDistanceCorrection,applyDistanceCorrection} from './distance-calibration.mjs';

const $ = id => document.getElementById(id);
const ui = Object.fromEntries(['notice','stageBadge','artTitle','artSubtitle','previewSlot','cameraPlaceholder','cameraState','faceLight','faceStatus','frameRate','connectBtn','stopBtn','calibrateBtn','practiceBtn','baselineBtn','motionBtn','conditions','exportCsvBtn','exportJsonBtn','resultContext','resultsEmpty','resultsContent','metricMedian','metricMedianPct','metricGrid','metricJitter','metricValid','metricHz','plotCondition','resultPlot','comparisonBody','resultQuality','protocolOverlay','protocolLabel','protocolCounter','overlayTestBtn','overlayExitBtn','targetDot','gazeDot','protocolInstruction','protocolStatus','protocolProgress'].map(id => [id, $(id)]));
for(const id of ['trackingMode','calibrationCount','testCount','motionKind','calibrationStepTitle','calibrationStepHint','modelFallback','modelFallbackText','fallbackBtn','poseReadouts','poseDistance','poseYaw','posePitch','poseRoll','compensationComparison',
  'distanceControl','distanceCalibrateBtn','distanceCalibrationStatus','distanceComparison',
  'readDeviceBtn','deviceStatus','deviceFields','deviceSummary','sizeSource','detectedSize','displayPicker','displayChoice','manualSize','screenWidthCm','screenHeightCm','cameraPlacement','manualCamera','cameraXCm','cameraYCm','cameraProfile'])ui[id]=$(id);
let mode = 'idle';
let starting = false;
let active = false;
let engineFrame = null;
let engine = null;
let generation = 0;
let calibrated = false;
let calibration = null;
let clock = null;
let pendingRound = null;
let lastFrameAt = 0;
let eyesPresent = false;
let latestPrediction = null;
let smoothPrediction = null;
let stablePrediction = null;
const displayStabilizer = new DisplayStabilizer();
let frameTimes = [];
let lastTrainingAt = -Infinity;
let pointStartedAt = 0;
let selectedRoundId = null;
let cameraSettings = {};
let qualityReason = 'face-missing';
let latestQuality={};
let referenceState=null;
let distanceGroups=null;
let compensationAvailable=false;
let displays=[], readingDevice=false, enteringFullscreen=false, displayGeometry=null, displayKey=null;
let lastFrameId=null, predictionAt=0;
const natural=()=>ui.trackingMode.value==='natural';
const calibrationCount=()=>natural()?Number(ui.calibrationCount.value):16;
const motionLabels={distance:'前后移动',yaw:'左右转头',pitch:'抬头低头',lateral:'左右平移',roll:'歪头'};
const motionInstructions={distance:'注视圆点，缓慢靠近或后退约 10 厘米。',yaw:'注视圆点，缓慢左右转头，先从约 10° 开始。',pitch:'注视圆点，缓慢抬头或低头，先从约 10° 开始。',lateral:'注视圆点，头部朝前，向左或右平移约 5 厘米。',roll:'注视圆点，缓慢向两侧歪头，先从约 10° 开始。'};
const calibrations = [];
const rounds = [];
const conditionLabel = { baseline: '坐稳', motion: '轻微移动' };
const viewport = () => ({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio });
const metric = (value, suffix = '', digits = 0) => value === null || value === undefined ? '—' : `${value.toFixed(digits)}${suffix}`;
const percent = value => value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
const busy = () => ['reference','calibration','distance-calibration','baseline','motion'].includes(mode);
const locked = () => busy() || enteringFullscreen || readingDevice;
const sourceNames = {detected:'系统读取',manual:'手动输入',estimated:'估算'};
const hasSize = display => display?.widthCm>0 && display?.heightCm>0;
const selectedDisplay = () => displays[Number(ui.displayChoice.value)];
const countTraining = () => calibration?.sampleCounts.reduce((sum,n)=>sum+n,0) ?? 0;
const activeDistanceCalibration = () => calibrated ? calibration?.distanceCalibrations?.at(-1) : null;
const distanceReady = (pose,side) => distanceSide(pose?.distanceRatio)===side&&
  [pose.yaw,pose.pitch,pose.roll].every(angle=>Number.isFinite(angle)&&Math.abs(angle)<=16);

function notice(text, tone = 'info') {
  ui.notice.textContent = text;
  ui.notice.dataset.tone = tone;
  ui.notice.hidden = !text;
}

function makeDisplayGeometry(size) {
  const display=selectedDisplay();
  const source=ui.sizeSource.value;
  const [widthCm,heightCm]=source==='manual'?[ui.screenWidthCm.valueAsNumber,ui.screenHeightCm.valueAsNumber]:
    source==='detected'?[display?.widthCm,display?.heightCm]:[31,31*size.height/size.width];
  if (![widthCm,heightCm].every(value=>Number.isFinite(value)&&value>=5&&value<=300)) {
    throw new Error('请填写有效屏宽、屏高，单位为厘米；也可选择估算尺寸。');
  }
  const placement=ui.cameraPlacement.value;
  const [cameraXCm,cameraYCm]=placement==='custom'?[ui.cameraXCm.valueAsNumber,ui.cameraYCm.valueAsNumber]:
    [widthCm/2,placement==='bottom'?heightCm+1.5:-1.5];
  if (![cameraXCm,cameraYCm].every(Number.isFinite)) {
    throw new Error('请填写摄像头 X、Y 位置。摄像头位于屏幕上方时，Y 填负数。');
  }
  return {widthCm,heightCm,diagonalInches:Math.hypot(widthCm,heightCm)/2.54,
    resolutionWidth:display?.resolutionWidth??null,resolutionHeight:display?.resolutionHeight??null,
    displayIndex:display?Number(ui.displayChoice.value)+1:null,screenSizeSource:source,
    cameraXCm,cameraYCm,cameraPositionSource:placement==='custom'?'manual':'estimated',cameraPlacement:placement,viewport:size};
}

function showDeviceProfile() {
  const display=selectedDisplay();
  ui.detectedSize.disabled=!hasSize(display);
  if(ui.sizeSource.value==='detected'&&!hasSize(display))ui.sizeSource.value='estimated';
  ui.displayPicker.hidden=displays.length<2;
  ui.manualSize.hidden=ui.sizeSource.value!=='manual';
  ui.manualCamera.hidden=ui.cameraPlacement.value!=='custom';
  const resolution=display?.resolutionWidth&&display?.resolutionHeight? ` · ${display.resolutionWidth} × ${display.resolutionHeight} px`:'';
  try {
    const profile=makeDisplayGeometry({width:screen.width||innerWidth,height:screen.height||innerHeight});
    ui.deviceSummary.textContent=`屏幕 ${profile.widthCm.toFixed(1)} × ${profile.heightCm.toFixed(1)} cm · 约 ${profile.diagonalInches.toFixed(1)} 英寸${resolution} · ${sourceNames[profile.screenSizeSource]}`;
  } catch(error) {ui.deviceSummary.textContent=error.message;}
}

function deviceChanged() {
  showDeviceProfile();
  if(!natural() || !displayGeometry) return;
  try {
    if(JSON.stringify(makeDisplayGeometry(displayGeometry.viewport))===JSON.stringify(displayGeometry))return;
  } catch { /* An incomplete geometry input also invalidates the current mapping. */ }
  const wasCalibrated=calibrated;
  displayGeometry=null;
  displayKey=null;
  engine?.setScreenGeometry(null);
  calibrated=false;
  latestPrediction=null;
  latestQuality={};
  if(wasCalibrated)notice('设备参数已更新。可以直接追踪，或按新参数重新校准。');
  updateControls();
}

async function readDevice() {
  if(locked())return;
  readingDevice=true;
  updateControls();
  ui.deviceStatus.textContent='正在读取本机屏幕信息…';
  try {
    const response=await fetch('./device-info',{signal:AbortSignal.timeout(5000),cache:'no-store'});
    if(!response.ok)throw new Error('Device information unavailable');
    const data=await response.json();
    if(!Array.isArray(data.displays))throw new Error('Invalid display information');
    displays=data.displays;
    ui.displayChoice.replaceChildren(...displays.map((display,index)=>new Option(
      `屏幕 ${index+1}${display.primary?'（主屏）':''} · ${display.resolutionWidth} × ${display.resolutionHeight}${hasSize(display)?` · ${display.widthCm} × ${display.heightCm} cm`:''}`,index,
    )));
    if(displays.length)ui.displayChoice.value=String(Math.max(0,displays.findIndex(display=>display.primary)));
    const display=selectedDisplay();
    if(hasSize(display) && ui.sizeSource.value!=='manual')ui.sizeSource.value='detected';
    ui.deviceStatus.textContent=displays.length>1?'请选择浏览器当前所在的屏幕，再开始全屏追踪。':
      hasSize(display)?'已读取 Windows 报告的屏幕尺寸和当前分辨率。':'本机未报告屏幕物理尺寸，可使用估算值或手动输入。';
    deviceChanged();
  } catch {
    ui.deviceStatus.textContent='暂时无法读取本机屏幕信息。可使用估算值或手动输入。';
  } finally {
    readingDevice=false;
    updateControls();
  }
}

function updateControls() {
  const ready=active&&(natural()?compensationAvailable:calibrated)&&!locked();
  const testSeconds=Number(ui.testCount.value)*3;
  ui.connectBtn.disabled = active || starting;
  ui.connectBtn.innerHTML = starting ? '正在准备摄像头…' : active ? '摄像头已连接 <span>✓</span>' : '连接摄像头 <span>↗</span>';
  ui.stopBtn.disabled = !active && !starting;
  ui.calibrateBtn.disabled = !active || locked() || (natural()&&!compensationAvailable);
  ui.calibrateBtn.innerHTML = `${calibrated?'重新校准':'开始校准'} <span>↗</span>`;
  ui.trackingMode.disabled=starting||locked();
  ui.motionKind.disabled=locked();
  ui.calibrationCount.disabled=locked()||!natural();
  ui.distanceControl.hidden=!natural();
  ui.distanceCalibrateBtn.disabled=!ready||!calibrated;
  ui.distanceCalibrationStatus.textContent=activeDistanceCalibration()?'距离修正已启用':calibrated?'已完成个人校准':'先做个人校准';
  ui.testCount.disabled=locked();
  ui.readDeviceBtn.disabled=locked();
  ui.deviceFields.querySelectorAll('select,input').forEach(control=>{control.disabled=locked();});
  ui.calibrationStepTitle.textContent=natural()?'全屏追踪':'16 点精细校准';
  ui.calibrationStepHint.textContent=natural()?'连接后直接使用，可选个人校准':'约 48 秒，头部坐稳，只用目光跟随';
  ui.poseReadouts.hidden=!natural();
  ui.practiceBtn.disabled = !ready;
  ui.practiceBtn.innerHTML = natural()?'全屏追踪 <span>↗</span>':'自由观察 <span>↗</span>';
  ui.baselineBtn.disabled = !ready;
  ui.motionBtn.disabled = !ready;
  ui.baselineBtn.querySelector('span').textContent=`约 ${testSeconds} 秒 →`;
  ui.motionBtn.querySelector('span').textContent=`约 ${testSeconds} 秒 →`;
  ui.exportCsvBtn.disabled = !rounds.length;
  ui.exportJsonBtn.disabled = !rounds.length;
  ui.stageBadge.textContent = busy() ? '实验进行中' : calibrated ? '已校准 · 可以测试' : active ? '摄像头就绪' : '等待开始';
  document.querySelector('[data-step="camera"]').classList.toggle('done', active);
  document.querySelector('[data-step="calibration"]').classList.toggle('done', calibrated);
  document.querySelector('[data-step="validation"]').classList.toggle('done', rounds.length>0);
  ui.artTitle.textContent = (calibrated || (active&&natural())) ? '准备好，看看目光的轨迹' : active ? '用 16 个位置校准你的目光' : '让目光成为一种输入';
  ui.artSubtitle.textContent = calibrated ? '自由观察，或开始一次独立精度测试。' : active ? natural()?'可直接全屏追踪，或先校准以调整个人偏差。':'精细校准约 48 秒，保持坐姿并用目光跟随圆点。' : '先了解它的精度，再探索它的用途。';
}

function setMode(next) {
  mode = next;
  document.body.dataset.mode = next;
  ui.protocolOverlay.hidden = next === 'idle';
  ui.targetDot.hidden = !busy()||next==='reference';
  ui.gazeDot.hidden = true;
  ui.overlayTestBtn.hidden = next !== 'practice';
  ui.overlayExitBtn.textContent = next === 'practice' ? '返回控制台' : '结束本轮';
  ui.protocolLabel.textContent = next==='reference'?'记录参考坐姿':next === 'calibration' ? `${calibration.targets.length} 点校准` : next==='distance-calibration'?'近／远补充校准':next === 'practice' ? '全屏追踪' : next === 'motion' ? `${motionLabels[ui.motionKind.value]}测试` : '坐稳精度测试';
  ui.protocolCounter.textContent = next === 'practice' ? (calibrated?'已校准':'免校准') : next==='reference'?'约 2 秒':clock?`1 / ${clock.points.length}`:'';
  ui.protocolInstruction.textContent = next==='reference'?'保持舒适坐姿，正对摄像头，双眼清晰入镜。':next === 'motion' ? motionInstructions[ui.motionKind.value] : next === 'practice' ? '先保持自然坐姿片刻，然后看向不同位置。' : '保持头部坐稳，注视圆点中心。';
  smoothPrediction = null;
  stablePrediction = null;
  displayStabilizer.reset();
  updateControls();
}

function friendlyError(error) {
  const name = error?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return '摄像头权限未开启。请在浏览器地址栏的网站设置中允许摄像头，然后重新连接。';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没有找到可用摄像头。请检查设备连接及 Windows 摄像头设置。';
  if (name === 'NotReadableError' || name === 'TrackStartError') return '摄像头暂时无法读取。请关闭可能占用摄像头的会议或录像程序，再重新连接。';
  if (name === 'OverconstrainedError') return '摄像头不支持当前采集设置。请换用内置摄像头或其他摄像头后重试。';
  return error?.message || '摄像头或本地模型未能启动，请重新连接。';
}

async function connect() {
  if (active || starting) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    notice('请通过启动脚本打开 localhost 地址，并使用 Chrome 或 Edge。直接打开 HTML 文件无法启动此实验。');
    return;
  }
  const thisGeneration = ++generation;
  starting = true;
  notice('正在加载本地模型。浏览器询问时，请允许使用摄像头。');
  ui.cameraState.textContent = '准备中';
  updateControls();
  engineFrame = document.createElement('iframe');
  engineFrame.title = '本机摄像头实时预览';
  engineFrame.allow = 'camera';
  engineFrame.dataset.connectionId = String(thisGeneration);
  const frame = engineFrame;
  ui.previewSlot.append(frame);
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('本地摄像头模块加载超时，请检查文件完整性并重新连接。')), 15000);
      window.gazeLabEngineReady = id => { if (id === thisGeneration) { clearTimeout(timeout); resolve(); } };
      frame.src = './engine.html';
    });
    if (thisGeneration !== generation) return;
    engine = frame.contentWindow.gazeEngine;
    let startupTimeout;
    let settings;
    try {
      settings = await Promise.race([
        engine.startEngine(thisGeneration,{mode:ui.trackingMode.value}),
        new Promise((_, reject) => { startupTimeout = setTimeout(() => reject(new Error('摄像头或本地模型启动超时。请检查摄像头授权及模型文件，然后重新连接。')), 60000); }),
      ]);
    } finally {
      clearTimeout(startupTimeout);
    }
    if (thisGeneration !== generation) return;
    cameraSettings = { width: settings.width ?? null, height: settings.height ?? null, frameRate: settings.frameRate ?? null, facingMode: settings.facingMode ?? null };
    const dimensions=cameraSettings.width&&cameraSettings.height?`${cameraSettings.width} × ${cameraSettings.height} px`:'尺寸未知';
    const configuredRate=cameraSettings.frameRate?` · 配置 ${cameraSettings.frameRate.toFixed(1)} fps`:'';
    const facing={user:'前置',environment:'后置',left:'左侧',right:'右侧'}[cameraSettings.facingMode];
    ui.cameraProfile.textContent=`${dimensions}${configuredRate}${facing?` · ${facing}`:''}`;
    compensationAvailable=Boolean(settings.compensation?.available);
    ui.trackingMode.querySelector('[value="natural"]').disabled=!compensationAvailable;
    ui.modelFallback.hidden=compensationAvailable;
    if(!compensationAvailable) {
      ui.trackingMode.value='precision';
      ui.modelFallbackText.textContent='自然移动模型暂不可用，已保留坐稳精细模式。可检查本地模型文件后重新连接。';
    }
    starting = false;
    active = true;
    lastFrameAt = performance.now();
    ui.cameraPlaceholder.hidden = true;
    ui.cameraState.textContent = '已连接';
    notice(natural()?'摄像头已连接。可以直接全屏追踪，也可以先做个人校准。':'精细虹膜模型已连接。让双眼清晰入镜，然后完成 16 点精细校准。', 'success');
    updateControls();
  } catch (error) {
    if (thisGeneration !== generation) return;
    console.error('Gaze Lab camera start failed:', error);
    stopCamera(false);
    notice(friendlyError(error));
  }
}

function stopCamera(showNotice = true) {
  generation++;
  const interrupted = busy();
  if (interrupted && ['reference','calibration'].includes(mode) && calibration) calibration.status = 'interrupted';
  clock = null;
  referenceState=null;
  distanceGroups=null;
  pendingRound = null;
  try { engine?.stopEngine(); } catch { /* Removing the iframe also tears down its camera context. */ }
  engineFrame?.remove();
  engineFrame = null;
  engine = null;
  active = false;
  starting = false;
  calibrated = false;
  calibration=null;
  lastFrameId=null;
  displayGeometry=null;
  displayKey=null;
  eyesPresent = false;
  latestPrediction = null;
  latestQuality={};
  frameTimes = [];
  ui.cameraPlaceholder.hidden = false;
  ui.cameraState.textContent = '未连接';
  ui.cameraProfile.textContent='连接后显示摄像头采集参数。';
  ui.faceStatus.textContent = '等待摄像头';
  ui.faceLight.classList.remove('detected');
  ui.frameRate.textContent = '— Hz';
  setMode('idle');
  leaveFullscreen();
  if (showNotice) notice('摄像头已停止。已完成的测试仍可查看和导出。', 'success');
}

window.gazeLabEngineError = (message, connectionId) => {
  if (connectionId !== generation) return;
  if (!active && !starting) return;
  stopCamera(false);
  notice(`追踪中断：${message || '本地模型运行失败'}。请重新连接摄像头。`);
};

function ensureViewport() {
  if(natural()&&!document.fullscreenElement)return true;
  const expected=natural()?displayGeometry?.viewport:calibrated||mode==='calibration'?calibration?.viewport:null;
  if (expected && JSON.stringify(viewport())!==JSON.stringify(expected)) {
    invalidateCalibration('屏幕显示范围已变化。可重新开启追踪，或重新校准。');
    return false;
  }
  return true;
}

function leaveFullscreen() {
  if(document.fullscreenElement)void document.exitFullscreen().catch(()=>{});
}

async function prepareTracking() {
  if(!active||locked()||(natural()&&!compensationAvailable))return null;
  if(!natural())return viewport();
  const connection=generation;
  enteringFullscreen=true;
  updateControls();
  try {
    makeDisplayGeometry({width:screen.width||innerWidth,height:screen.height||innerHeight});
    if(!document.fullscreenElement) {
      try {await document.documentElement.requestFullscreen();}
      catch {throw new Error('浏览器没有进入全屏。请在当前标签页点击全屏追踪，或选择坐稳精细模式。');}
    }
    if(connection!==generation||!active) {leaveFullscreen();return null;}
    const size=viewport();
    const profile=makeDisplayGeometry(size);
    const key=JSON.stringify({profile,screenX,screenY});
    if(key!==displayKey) {
      engine.setScreenGeometry(profile);
      displayGeometry=profile;
      displayKey=key;
      calibrated=false;
      latestPrediction=null;
    }
    return size;
  } catch(error) {
    leaveFullscreen();
    notice(error.message);
    return null;
  } finally {
    enteringFullscreen=false;
    updateControls();
  }
}

async function startCalibration() {
  const size=await prepareTracking();
  if(!size)return;
  if (size.width < 640 || size.height < 480) {
    leaveFullscreen();
    notice('请将显示区域扩大至至少 640 × 480，再开始校准。');
    return;
  }
  engine.clearTraining();
  latestPrediction=null;
  calibrated = false;
  const count=calibrationCount();
  const targets = pointsFor(count===9?'calibration':'precision', size.width, size.height);
  const protocol=natural()?{...NATURAL_PROTOCOL,minCalibrationSamples:count===9?8:12}:{...PROTOCOL};
  calibration = { id: crypto.randomUUID(), createdAt: new Date().toISOString(),trackingMode:ui.trackingMode.value,protocol, viewport: size, display:displayGeometry, camera: { ...cameraSettings }, notes: ui.conditions.value.trim(), targets, sampleCounts: Array(targets.length).fill(0), status: 'in-progress' };
  calibrations.push(calibration);
  const now = performance.now();
  clock = natural()?null:new TargetClock(calibration.targets, now);
  if(natural()) {engine.beginReference();referenceState={elapsed:0,lastAt:now,startedAt:now};}
  pointStartedAt = now;
  lastTrainingAt = -Infinity;
  pendingRound = null;
  setMode(natural()?'reference':'calibration');
  notice('');
  renderResults();
}

async function startPractice() {
  if (!natural()&&!calibrated) return;
  if(!await prepareTracking() || !ensureViewport())return;
  clock = null;
  setMode('practice');
  notice('');
}

async function startDistanceCalibration() {
  if(!natural()||!calibrated)return;
  const size=await prepareTracking();
  if(!size||!ensureViewport())return;
  if(!calibrated) {
    leaveFullscreen();
    notice('显示参数已变化，请先重新完成个人校准。');
    return;
  }
  const points=distanceTargets(size);
  distanceGroups=points.map(target=>({target,samples:[]}));
  pointStartedAt=performance.now();
  lastTrainingAt=-Infinity;
  clock=new TargetClock(points,pointStartedAt);
  setMode('distance-calibration');
  notice('');
}

async function startRound(condition) {
  if (!natural()&&!calibrated) return;
  const size=await prepareTracking();
  if(!size || !ensureViewport())return;
  const targets = shuffled(pointsFor(ui.testCount.value==='16'?'validation16':'validation', size.width, size.height));
  pendingRound = { id: crypto.randomUUID(), calibrationId: calibrated?calibration.id:null, calibrationPoints:calibrated?calibration.targets.length:0,
    distanceCalibrationId:activeDistanceCalibration()?.id??null,
    condition,trackingMode:ui.trackingMode.value,motionKind:condition==='motion'?ui.motionKind.value:null, startedAt: new Date().toISOString(),
    connection:generation, viewport: size, display:displayGeometry, camera:{...cameraSettings}, notes: ui.conditions.value.trim(), targets, samples: [],
    trainingSamplesBefore: calibrated?countTraining():0 };
  pointStartedAt = performance.now();
  clock = new TargetClock(targets, pointStartedAt);
  setMode(condition);
  notice('');
}

function finishProtocol() {
  const finishedMode = mode;
  clock = null;
  if(finishedMode==='distance-calibration') {
    try {
      const model=fitDistanceCorrection(distanceGroups,calibration.viewport);
      const targets=distanceGroups.map(({target,samples})=>({...target,sampleCount:samples.length}));
      (calibration.distanceCalibrations??=[]).push({id:crypto.randomUUID(),model,targets,createdAt:new Date().toISOString()});
      notice('近／远校准完成。可做前后移动测试，检查距离修正是否有效。','success');
    } catch(error) {
      notice(error.message);
    }
    distanceGroups=null;
    setMode('idle');
    leaveFullscreen();
  } else if (finishedMode === 'calibration') {
    try {
      calibration.model = engine.finalizeTraining({...calibration.viewport,requiredTargets:calibration.targets.length,minSamples:calibration.protocol.minCalibrationSamples});
    } catch (error) {
      calibration.status = 'failed';
      calibrated = false;
      setMode('idle');
      leaveFullscreen();
      notice(error.message || '校准数据不完整，请重新校准。');
      return;
    }
    calibrated = true;
    calibration.status = 'complete';
    calibration.completedAt = new Date().toISOString();
    setMode('idle');
    leaveFullscreen();
    notice(`${calibration.targets.length} 点校准完成。可以观察目光落点，或做一次独立测试。`, 'success');
  } else {
    pendingRound.completedAt = new Date().toISOString();
    pendingRound.trainingSamplesAfter = calibrated?countTraining():0;
    pendingRound.summary = summarize(pendingRound.samples, pendingRound.targets, pendingRound.viewport.width, pendingRound.viewport.height);
    if(pendingRound.trackingMode==='natural') {
      const {samples,targets,viewport:{width,height},distanceCalibrationId}=pendingRound;
      const geometrySamples=distanceCalibrationId?samples.map(sample=>({...sample,x:sample.geometryX,y:sample.geometryY})):samples;
      pendingRound.compensationComparison=pairedSummaries(geometrySamples,targets,width,height);
      if(distanceCalibrationId) pendingRound.distanceComparison=pairedSummaries(samples.map(sample=>({...sample,beforeX:sample.geometryX,beforeY:sample.geometryY})),targets,width,height);
    }
    rounds.push(pendingRound);
    selectedRoundId = pendingRound.id;
    pendingRound = null;
    setMode('idle');
    leaveFullscreen();
    renderResults();
    notice(finishedMode === 'baseline' ? '坐稳测试完成。可选择移动测试，或导出本轮结果。' : '移动测试完成。可查看同帧补偿对比及原始结果。', 'success');
    ui.resultContext.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function cancelProtocol(message = '本轮已结束，未完成的测量不计入结果。') {
  if (['reference','calibration'].includes(mode)) {
    calibrated = false;
    if (calibration) calibration.status = 'interrupted';
    engine?.clearTraining();
  }
  clock = null;
  referenceState=null;
  distanceGroups=null;
  pendingRound = null;
  setMode('idle');
  leaveFullscreen();
  notice(message);
}

function invalidateCalibration(message) {
  const wasCalibrating=['reference','calibration'].includes(mode);
  cancelProtocol(message);
  calibrated = false;
  if(!wasCalibrating)engine?.clearTraining();
  displayKey=null;
  updateControls();
}

function advanceProtocol(now) {
  if(mode==='reference'&&referenceState) {
    const state=referenceState;
    if(eyesPresent&&now-lastFrameAt<250)state.elapsed+=Math.max(0,now-state.lastAt);
    state.lastAt=now;
    if(now-state.startedAt>30000) {cancelProtocol('参考坐姿采样不稳定，请改善光线后重试，或切换坐稳精细模式。');return;}
    if(state.elapsed>=NATURAL_PROTOCOL.referenceMs&&(latestQuality.referenceSamples??0)>=12) {
      try {calibration.reference=engine.finishReference();}
      catch(error) {cancelProtocol(error.message);return;}
      referenceState=null;clock=new TargetClock(calibration.targets,now);pointStartedAt=now;setMode('calibration');
    }
    return;
  }
  if (!clock) return;
  const isCalibration = mode === 'calibration';
  const isDistance = mode === 'distance-calibration';
  const detected = eyesPresent && now - lastFrameAt < (natural()?250:750);
  const allowedToFinish = isDistance ? distanceGroups[clock.index].samples.length>=MIN_DISTANCE_SAMPLES:
    !isCalibration || calibration.sampleCounts[clock.index] >= calibration.protocol.minCalibrationSamples;
  const enabled=isDistance?detected&&distanceReady(latestQuality.pose,clock.point.side):!isCalibration||detected;
  const changed = clock.update(now, enabled, allowedToFinish);
  if (changed) pointStartedAt = now;
  if (clock.done) { finishProtocol(); return; }
  if(isDistance&&now-pointStartedAt>30000) {
    cancelProtocol('没有采到足够的近／远样本。可重试，按屏幕提示调整前后距离。');
  } else if (isCalibration && now - pointStartedAt > 30000) {
    cancelProtocol('眼部检测或采样不够稳定，本次校准已结束。请调整光线和坐姿后重新校准。');
  }
}

window.gazeLabFrame = (prediction, detected, connectionId, quality = {}) => {
  if (connectionId !== generation) return;
  if(Number.isFinite(quality.frameId)) {
    if(lastFrameId!==null&&quality.frameId<=lastFrameId)return;
    lastFrameId=quality.frameId;
  }
  const now = performance.now();
  const capturedAt=Number.isFinite(quality.capturedAt)?quality.capturedAt-performance.timeOrigin:now;
  lastFrameAt = now;
  eyesPresent = Boolean(detected);
  latestQuality=quality;
  if(quality.compensation?.available===false&&natural()&&compensationAvailable) {
    compensationAvailable=false;ui.modelFallback.hidden=false;
    ui.modelFallbackText.textContent='自然移动模型不可用，可结束本轮并切换坐稳精细模式。';
    if(mode!=='idle')cancelProtocol('自然移动模型已中断。可在控制台切换到坐稳精细模式。');
    updateControls();
  }
  qualityReason = quality.reason || (detected ? 'good' : 'face-missing');
  const geometricPrediction=prediction;
  const distanceRatio=quality.pose?.distanceRatio;
  prediction=applyDistanceCorrection(prediction,distanceRatio,activeDistanceCalibration()?.model);
  latestPrediction = detected && finitePrediction(prediction) ? prediction : null;
  predictionAt=capturedAt;
  if (mode === 'practice') stablePrediction = displayStabilizer.push(latestPrediction, now);
  frameTimes.push(now);
  frameTimes = frameTimes.filter(time => now - time < 1000);
  advanceProtocol(now);
  // A result that started before the target settled does not belong to its capture phase.
  const inCapture=clock?.capturing && capturedAt>=pointStartedAt+clock.settleMs;
  if (inCapture && trainingAllowed(mode, true, detected) && now - lastTrainingAt >= PROTOCOL.calibrationIntervalMs-0.5) {
    const accepted = engine.train(clock.point.x, clock.point.y);
    if (accepted) calibration.sampleCounts[clock.index]++;
    lastTrainingAt = now;
  }
  if(inCapture&&mode==='distance-calibration'&&detected&&finitePrediction(geometricPrediction)&&
      distanceReady(quality.pose,clock.point.side)&&now-lastTrainingAt>=PROTOCOL.calibrationIntervalMs-0.5) {
    const group=distanceGroups[clock.index];
    if(group.samples.length<32)group.samples.push({...geometricPrediction,ratio:distanceRatio});
    lastTrainingAt=now;
  }
  if (inCapture && pendingRound) {
    const target = clock.point;
    const valid = detected && finitePrediction(prediction);
    const before=valid&&finitePrediction(quality.before)?quality.before:null;
    const round=pendingRound;
    const display=round.display;
    round.samples.push({
      roundId:round.id,condition:round.condition,timeMs:Math.round(capturedAt*1000)/1000,
      targetId:target.id,targetX:target.x,targetY:target.y,x:valid?prediction.x:null,y:valid?prediction.y:null,
      valid,eyesDetected:Boolean(detected),errorPx:valid?Math.hypot(prediction.x-target.x,prediction.y-target.y):null,
      viewportWidth:round.viewport.width,viewportHeight:round.viewport.height,trackingMode:round.trackingMode,motionKind:round.motionKind,
      modelId:quality.modelId??'precision-calibration-ridge',provider:quality.provider??null,
      beforeX:before?.x??null,beforeY:before?.y??null,beforeErrorPx:before?Math.hypot(before.x-target.x,before.y-target.y):null,
      geometryX:valid&&round.trackingMode==='natural'?geometricPrediction?.x??null:null,
      geometryY:valid&&round.trackingMode==='natural'?geometricPrediction?.y??null:null,
      distanceCalibrationId:round.distanceCalibrationId,gazeYawDeg:quality.gazeYawDeg??null,gazePitchDeg:quality.gazePitchDeg??null,
      distanceRatio:quality.pose?.distanceRatio??null,headYawDeg:quality.pose?.yaw??null,headPitchDeg:quality.pose?.pitch??null,headRollDeg:quality.pose?.roll??null,
      poseFitError:quality.pose?.fitError??null,latencyMs:quality.latencyMs??null,qualityReason:quality.reason??null,
      frameId:quality.frameId??null,frameAgeMs:quality.frameAgeMs??null,
      calibrationId:round.calibrationId,calibrationPoints:round.calibrationPoints,testPoints:round.targets.length,
      screenSizeSource:display?.screenSizeSource??null,screenWidthCm:display?.widthCm??null,screenHeightCm:display?.heightCm??null,
      screenResolutionWidth:display?.resolutionWidth??null,screenResolutionHeight:display?.resolutionHeight??null,
      cameraPositionSource:display?.cameraPositionSource??null,cameraXCm:display?.cameraXCm??null,cameraYCm:display?.cameraYCm??null,
      cameraWidth:round.camera.width,cameraHeight:round.camera.height,cameraFrameRate:round.camera.frameRate,cameraFacingMode:round.camera.facingMode,
    });
  }
};

let lastPaint = 0;
function paint() {
  const now=performance.now();
  const delta = Math.min(100, Math.max(1, now - lastPaint));
  lastPaint = now;
  if (active) {
    const fresh = now - lastFrameAt < (natural()?250:1000);
    const reasons={'blink':'眨眼中，已跳过此帧','eyes-small':'眼部太小，请适当靠近','pose-unreliable':'姿态识别不稳，请正对摄像头','pose-out-of-range':'超出当前补偿范围，请回到参考坐姿','stale-frame':'推理较慢，已丢弃过期结果','model-unavailable':'自然移动模型不可用','gaze-away':'请看向屏幕'};
    ui.faceStatus.textContent = eyesPresent && fresh ? '虹膜已检测' : reasons[qualityReason]||'请让双眼清晰入镜';
    const pose=fresh?latestQuality.pose:null;
    ui.poseDistance.textContent=pose?.distanceRatio?`${pose.distanceRatio.toFixed(2)} ×`:'待记录';
    for(const [field,key] of [['poseYaw','yaw'],['posePitch','pitch'],['poseRoll','roll']])ui[field].textContent=Number.isFinite(pose?.[key])?`${pose[key]>0?'+':''}${pose[key].toFixed(1)}°`:'—';
    ui.faceLight.classList.toggle('detected', eyesPresent && fresh);
    ui.frameRate.textContent = `${frameTimes.filter(time => now - time < 1000).length} Hz`;
    if (now - lastFrameAt > 8000) {
      stopCamera(false);
      notice('追踪长时间没有返回数据，摄像头已释放。请重新连接，必要时关闭占用摄像头的其他程序。');
    }
  }
  advanceProtocol(now);
  if(mode==='reference'&&referenceState) {
    ui.protocolStatus.textContent=eyesPresent?'正在记录参考距离和朝向…':'双眼和姿态需清晰可见，计时已暂停';
    ui.protocolProgress.style.width=`${Math.min(100,referenceState.elapsed/2000*100)}%`;
  }
  if (clock) {
    const point = clock.point;
    ui.targetDot.style.left = `${point.x}px`;
    ui.targetDot.style.top = `${point.y}px`;
    ui.targetDot.classList.toggle('collecting', clock.capturing);
    ui.protocolCounter.textContent = `${clock.index + 1} / ${clock.points.length}`;
    ui.protocolProgress.style.width = `${Math.min(100, clock.elapsed / (PROTOCOL.settleMs + PROTOCOL.captureMs) * 100)}%`;
    ui.protocolStatus.textContent = mode === 'calibration' && (!eyesPresent || now - lastFrameAt > 750) ? '未检测到眼部区域，已暂停计时' : clock.capturing ? '保持注视，正在采集…' : '看向圆点，准备采集…';
    if(mode==='distance-calibration') {
      const ratio=latestQuality.pose?.distanceRatio;
      ui.protocolInstruction.textContent=point.side==='near'?'略向前靠，保持头部朝向，注视圆点。':'略向后坐，保持头部朝向，注视圆点。';
      const guide=distanceSide(ratio)===point.side?(distanceReady(latestQuality.pose,point.side)?ui.protocolStatus.textContent:'距离已到位，请把头转回原来朝向'):
        Number.isFinite(ratio)&&(ratio<0.72||ratio>1.30)?'移动过多，请稍微回到原坐姿':'请再稍微移动到提示的距离';
      ui.protocolStatus.textContent=eyesPresent&&now-lastFrameAt<250&&Number.isFinite(ratio)?`估计距离 ${ratio.toFixed(2)} × · ${guide}`:'请让双眼清晰入镜';
    }
  }
  if (mode === 'practice') {
    const freshPrediction=latestPrediction&&now-predictionAt<(natural()?250:750);
    const inside=freshPrediction&&latestPrediction.x>=0&&latestPrediction.y>=0&&latestPrediction.x<innerWidth&&latestPrediction.y<innerHeight;
    if (inside) {
      const weight = 1 - Math.exp(-delta / 95);
      const displayTarget = stablePrediction || latestPrediction;
      smoothPrediction = smoothPrediction ? { x: smoothPrediction.x + (displayTarget.x - smoothPrediction.x) * weight, y: smoothPrediction.y + (displayTarget.y - smoothPrediction.y) * weight } : { ...displayTarget };
      const {x,y}=smoothPrediction;
      ui.gazeDot.style.transform = `translate(${x - 8.5}px, ${y - 8.5}px)`;
      ui.gazeDot.hidden = false;
      ui.protocolStatus.textContent = `估算位置 x ${Math.round(latestPrediction.x)} · y ${Math.round(latestPrediction.y)}`;
    } else {
      ui.gazeDot.hidden = true;
      smoothPrediction = null;
      displayStabilizer.reset();
      stablePrediction=null;
      ui.protocolStatus.textContent = freshPrediction?'估计落点超出屏幕。':'等待有效预测，请保持双眼清晰入镜。';
    }
    ui.protocolProgress.style.width = '100%';
  }
  requestAnimationFrame(paint);
}

function renderResults() {
  const available = rounds;
  ui.resultsEmpty.hidden = available.length > 0;
  ui.resultsContent.hidden = available.length === 0;
  if (!available.length) {
    ui.resultContext.textContent = '完成一次独立测试后，这里会显示测量结果。';
    updateControls();
    return;
  }
  if (!available.some(r => r.id === selectedRoundId)) selectedRoundId = available.at(-1).id;
  const selected = available.find(r => r.id === selectedRoundId);
  const comparable=round=>round.calibrationId===selected.calibrationId&&round.targets.length===selected.targets.length&&
    round.distanceCalibrationId===selected.distanceCalibrationId&&
    round.trackingMode===selected.trackingMode&&round.connection===selected.connection&&
    JSON.stringify(round.viewport)===JSON.stringify(selected.viewport)&&JSON.stringify(round.display)===JSON.stringify(selected.display);
  const findRound=condition=>selected.condition===condition?selected:rounds.findLast(round=>round.condition===condition&&comparable(round));
  const baseline=findRound('baseline'),motion=findRound('motion');
  const stats = selected.summary;
  const testLabel=round=>`${round.condition==='motion'?motionLabels[round.motionKind]||'轻微移动':conditionLabel[round.condition]} · ${round.targets.length} 点测试`;
  ui.resultContext.textContent = `${selected.trackingMode==='natural'?'自然移动 · 实验':'坐稳精细'} · ${selected.calibrationPoints?`${selected.calibrationPoints} 点校准`:'免校准'} · ${testLabel(selected)} · ${selected.viewport.width} × ${selected.viewport.height} CSS px · 总计保存 ${rounds.length} 轮`;
  const comparison=selected.compensationComparison;
  ui.compensationComparison.hidden=!comparison;
  if(comparison)ui.compensationComparison.textContent=comparison.pairedSamples?`同帧中位误差 · 固定双眼位置 ${metric(comparison.before.medianErrorPx,' px')} · 实时更新位置 ${metric(comparison.after.medianErrorPx,' px')} · ${comparison.medianImprovementPct===null?'变化比例不可计算':comparison.medianImprovementPct>=0?'降低 '+comparison.medianImprovementPct.toFixed(1)+'%':'增加 '+Math.abs(comparison.medianImprovementPct).toFixed(1)+'%'} · ${comparison.pairedSamples} 条配对样本`:'本轮参考坐姿样本不足，暂无同帧位置对比。';
  const distanceComparison=selected.distanceComparison;
  ui.distanceComparison.hidden=!distanceComparison;
  if(distanceComparison) {
    ui.distanceComparison.textContent=`同帧距离校准对比 · 原几何 ${metric(distanceComparison.before.medianErrorPx,' px')} · 近／远校准后 ${metric(distanceComparison.after.medianErrorPx,' px')} · ${distanceComparison.pairedSamples} 条配对样本`;
  }
  ui.metricMedian.textContent = metric(stats.medianErrorPx, ' px');
  ui.metricMedianPct.textContent = stats.medianErrorDiagonalPct === null ? '尚无有效预测' : `窗口对角线的 ${stats.medianErrorDiagonalPct.toFixed(1)}%`;
  ui.metricGrid.textContent = percent(stats.gridHitRate);
  ui.metricJitter.textContent = metric(stats.jitterRmsPx, ' px');
  ui.metricValid.textContent = percent(stats.validPredictionRate);
  ui.metricHz.textContent = `${stats.predictionHz.toFixed(1)} 次有效预测 / 秒`;
  ui.plotCondition.replaceChildren(...available.map((round,index) => {
    const option = document.createElement('option');
    option.value = round.id;
    option.textContent = `第 ${index+1} 轮 · ${testLabel(round)}`;
    option.selected = round.id === selectedRoundId;
    return option;
  }));
  const rows = [
    ['中位误差', s => metric(s.medianErrorPx, ' px')],
    ['90% 分位误差', s => metric(s.p90ErrorPx, ' px')],
    ['九宫格命中率', s => percent(s.gridHitRate)],
    ['注视抖动', s => metric(s.jitterRmsPx, ' px')],
    ['有效预测比例', s => percent(s.validPredictionRate)],
    ['有效预测频率', s => metric(s.predictionHz, ' Hz', 1)],
  ];
  ui.comparisonBody.replaceChildren(...rows.map(([label, format]) => {
    const row = document.createElement('tr');
    for (const text of [label, baseline ? format(baseline.summary) : '—', motion ? format(motion.summary) : '—']) {
      const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
    }
    return row;
  }));
  const sparse = stats.perTarget.some(t => t.validSamples < 10);
  const ratios=selected.motionKind==='distance'?selected.samples.filter(sample=>sample.valid&&Number.isFinite(sample.distanceRatio)).map(sample=>sample.distanceRatio):[];
  const range=ratios.length?`估计距离 ${Math.min(...ratios).toFixed(2)}–${Math.max(...ratios).toFixed(2)} ×，其中 ${ratios.filter(r=>distanceSide(r)==='near').length} 帧在近端、${ratios.filter(r=>distanceSide(r)==='far').length} 帧在远端。`:'';
  ui.resultQuality.textContent = `${stats.targetsWithData} / ${selected.targets.length} 个目标有有效预测，共 ${stats.validSamples} 个有效样本。${range}${sparse ? '部分目标数据较少，建议调整光线或坐姿后重测。' : ''} 图中仅绘制窗口内的点，越界预测仍计入统计。`;
  drawPlot(selected);
  updateControls();
}

function drawPlot(round) {
  const canvas = ui.resultPlot;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const scale = devicePixelRatio || 1;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#f0f2e9'; ctx.fillRect(0, 0, width, height);
  const pad = 10;
  const project = (x, y) => [pad + x / round.viewport.width * (width - 2 * pad), pad + y / round.viewport.height * (height - 2 * pad)];
  ctx.strokeStyle = '#dce3d2'; ctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    const [x, y] = project(round.viewport.width * i / 3, round.viewport.height * i / 3);
    ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, height - pad); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(width - pad, y); ctx.stroke();
  }
  ctx.save(); ctx.beginPath(); ctx.rect(pad, pad, width - pad * 2, height - pad * 2); ctx.clip();
  for (const sample of round.samples) {
    if (!sample.valid) continue;
    const [x, y] = project(sample.x, sample.y);
    ctx.fillStyle = '#d1815833'; ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2); ctx.fill();
  }
  for (const target of round.summary.perTarget) {
    const [x, y] = project(target.x, target.y);
    if (target.meanX !== null) {
      const [mx, my] = project(target.meanX, target.meanY);
      ctx.strokeStyle = '#d1886266'; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(mx, my); ctx.stroke();
      ctx.strokeStyle = '#ce7c51'; ctx.beginPath(); ctx.arc(mx, my, 5, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = '#245d4c'; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function download(text, type, extension) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `gaze-lab-${new Date().toISOString().replaceAll(':', '-').slice(0, 19)}.${extension}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function report() {
  return { schemaVersion: 1, protocolVersion:3, app: 'Gaze Lab', appVersion: '1.4.1', exportedAt: new Date().toISOString(), engine: { name: 'WebGazer + MobileGaze', version: '3.5.3',pretrainedModel:'mobilegaze-mobileone-s0-gaze360',onnxRuntime:'1.31.1',compensation:'canonical-3d-similarity + ray-plane projection + optional affine and distance calibration',approximateIntrinsics:'fx=fy=max(videoWidth,videoHeight), principal point=image center, screen plane=camera z=0',comparison:'same-frame fixed eye position, geometry compensation and optional distance correction',regression: 'mode-specific', irisRefinement:true,uniqueCameraFrames:true,kalmanFilter: false, implicitMouseTraining: false }, protocol: PROTOCOL,naturalProtocol:NATURAL_PROTOCOL, units: { coordinates: 'viewport CSS pixels',deviceDimensions:'centimeters; see screen and camera position sources',headAngles:'degrees relative to reference posture; estimates',distance:'ratio to reference posture',errorPercentReference: 'viewport diagonal', validity: 'valid predictions / unique-frame inference callbacks during capture', frequency: 'valid predictions / planned capture seconds' }, calibrations, rounds };
}

function changeTrackingMode(next=ui.trackingMode.value) {
  if(busy()||mode==='practice')cancelProtocol('追踪模式已切换，请重新校准。');
  if(calibrated)invalidateCalibration('追踪模式已切换，请重新校准。');
  ui.trackingMode.value=next;
  if(active)engine.configureMode(next);
  displayGeometry=null;displayKey=null;
  latestPrediction=null;latestQuality={};eyesPresent=false;
  updateControls();
}
ui.trackingMode.addEventListener('change',()=>changeTrackingMode());
ui.fallbackBtn.addEventListener('click',()=>changeTrackingMode('precision'));
ui.readDeviceBtn.addEventListener('click',readDevice);
ui.testCount.addEventListener('change',updateControls);
ui.deviceFields.addEventListener('change',event=>{
  if(event.target===ui.displayChoice&&ui.sizeSource.value!=='manual')ui.sizeSource.value=hasSize(selectedDisplay())?'detected':'estimated';
  deviceChanged();
});

ui.connectBtn.addEventListener('click', connect);
ui.stopBtn.addEventListener('click', () => stopCamera());
ui.calibrateBtn.addEventListener('click', startCalibration);
ui.distanceCalibrateBtn.addEventListener('click',startDistanceCalibration);
ui.practiceBtn.addEventListener('click', startPractice);
ui.baselineBtn.addEventListener('click', () => startRound('baseline'));
ui.motionBtn.addEventListener('click', () => startRound('motion'));
ui.overlayTestBtn.addEventListener('click', () => startRound('baseline'));
ui.overlayExitBtn.addEventListener('click', () => cancelProtocol(mode==='practice'?'':undefined));
ui.plotCondition.addEventListener('change', () => { selectedRoundId = ui.plotCondition.value; renderResults(); });
ui.exportCsvBtn.addEventListener('click', () => download(samplesToCsv(rounds.flatMap(round => round.samples)), 'text/csv;charset=utf-8', 'csv'));
ui.exportJsonBtn.addEventListener('click', () => download(JSON.stringify(report(), null, 2), 'application/json;charset=utf-8', 'json'));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && mode !== 'idle') cancelProtocol(mode==='practice'?'':undefined);
});
document.addEventListener('fullscreenchange',()=>{
  if(natural()&&!document.fullscreenElement&&mode!=='idle')cancelProtocol(mode==='practice'?'':'已退出全屏，本轮已结束。');
  if(!document.fullscreenElement&&selectedRoundId) {
    const selected=rounds.find(round=>round.id===selectedRoundId);
    if(selected)drawPlot(selected);
  }
});
window.addEventListener('resize', () => {
  if (!enteringFullscreen && (!natural() || mode!=='idle')) ensureViewport();
  const selected = rounds.find(r => r.id === selectedRoundId);
  if (selected) drawPlot(selected);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && (busy() || mode === 'practice')) cancelProtocol('页面已切换到后台，本轮已结束。回到页面后可以重新开始测试。');
  lastFrameAt = performance.now();
});
window.addEventListener('pagehide', () => { try { engine?.stopEngine(); } catch {} });
showDeviceProfile();
updateControls();
requestAnimationFrame(paint);
