// Keep the upstream loop in an iframe, so stop/restart cannot leave an old loop alive.
import { installPrecisionRegression } from './precision-model.mjs';
import { combinedEyeFeatures, irisFeatures } from './eye-features.mjs';
import {FaceGeometry,eyeOrigin,projectGaze,projectToDisplay} from './face-geometry.mjs';
import {PretrainedGaze} from './pretrained-gaze.mjs';
import {RayCalibration} from './ray-calibration.mjs';
import {freshResult,MODEL_ID} from './gaze-input.mjs';

let webgazer;
let regression;
let eyesDetected = false;
let stopping = false;
let connectionId;
let freshFrame = false;
let lastFeatures = null;
let quality = {reason:'face-missing'};
let trackingMode='natural';
let pretrained,geometry;
let compensation={available:false,provider:null,error:null};
let packet=null;
let frameSequence=0,lastTrained=-1;
let screenGeometry=null,trackingEpoch=0,manualReference=false;
let sourceVideo,videoCallback,latestFrame,consumedFrame=-1,frameCanvas;
const rayModel=new RayCalibration();

function nextVideoFrame(video,canvas) {
  if (video!==sourceVideo) {
    sourceVideo?.cancelVideoFrameCallback?.(videoCallback);
    sourceVideo=video;latestFrame=null;consumedFrame=-1;
    if (video.requestVideoFrameCallback) {
      frameCanvas=document.createElement('canvas');
      const context=frameCanvas.getContext('2d');
      const present=(now,metadata)=>{
        if(stopping||video!==sourceVideo)return;
        if(frameCanvas.width!==video.videoWidth)frameCanvas.width=video.videoWidth;
        if(frameCanvas.height!==video.videoHeight)frameCanvas.height=video.videoHeight;
        if(frameCanvas.width&&frameCanvas.height) {
          context.drawImage(video,0,0);
          latestFrame={id:metadata.presentedFrames,at:metadata.captureTime??metadata.presentationTime??now};
        }
        videoCallback=video.requestVideoFrameCallback(present);
      };
      videoCallback=video.requestVideoFrameCallback(present);
    }
  }
  const counts=video.requestVideoFrameCallback?null:video.getVideoPlaybackQuality?.();
  // Non-video sources can supply an explicit frame timestamp (fixed-image QA).
  const frame=video.requestVideoFrameCallback?latestFrame:{
    id:counts?counts.totalVideoFrames-counts.droppedVideoFrames:video.currentTime,
    at:performance.now(),
  };
  if (!frame || !Number.isFinite(frame.id) || frame.id<=consumedFrame || (counts&&frame.id<=0)) return null;
  consumedFrame=frame.id;
  if(video.requestVideoFrameCallback)canvas.getContext('2d').drawImage(frameCanvas,0,0,canvas.width,canvas.height);
  return frame;
}

export async function startEngine(id,options={}) {
  connectionId = id;
  trackingMode=options.mode==='precision'?'precision':'natural';
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = './vendor/webgazer.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('本地追踪库未能加载。请检查 vendor 文件夹是否完整。'));
    document.head.append(script);
  });
  if(stopping)throw new Error('摄像头启动已取消。');
  webgazer = window.webgazer;
  regression = installPrecisionRegression(webgazer, eyes=>eyes.gazeVector || combinedEyeFeatures(eyes, value=>webgazer.util.getEyeFeats(value)));
  webgazer.params.faceMeshSolutionPath = './vendor/mediapipe/face_mesh';
  webgazer.saveDataAcrossSessions(false).applyKalmanFilter(false).showPredictionPoints(false).showFaceOverlay(false).showFaceFeedbackBox(false);
  webgazer.params.camConstraints = { video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user', frameRate: { ideal: 30 } }, audio: false };
  const tracker = webgazer.getTracker();
  const getEyePatches = tracker.getEyePatches.bind(tracker);
  tracker.getEyePatches = async (...args) => {
    const [video,canvas]=args;
    const frame=nextVideoFrame(video,canvas);
    freshFrame=Boolean(frame);
    if (!freshFrame) return lastFeatures;
    const startedAt=performance.now();
    const epoch=trackingEpoch;
    const needsGaze=trackingMode==='natural'&&(screenGeometry||manualReference||geometry?.reference);
    frameSequence++;
    eyesDetected = false;
    quality = {reason:'face-missing'};
    packet=null;
    try {
      // The detector, eye patches and CNN all see the same frozen canvas frame.
      const features = await getEyePatches(canvas,...args.slice(1));
      if (stopping||epoch!==trackingEpoch) {freshFrame=false;return null;}
      if (features?.left?.width>0 && features?.right?.width>0) {
        quality = irisFeatures(tracker.getPositions());
        eyesDetected = quality.valid;
        if (eyesDetected) features.gazeVector = combinedEyeFeatures(features,value=>webgazer.util.getEyeFeats(value),quality.vector);
        const pose=eyesDetected&&geometry?geometry.estimate(tracker.getPositions(),args[1].width,args[1].height):null;
        if(needsGaze) {
          if(!compensation.available) {eyesDetected=false;quality.reason='model-unavailable';}
          else if(!pose) {eyesDetected=false;if(quality.valid)quality.reason='pose-unreliable';}
          else if(eyesDetected) {
            let reply;
            try {reply=freshResult(frame.at,performance.now())?await pretrained.predict(canvas,tracker.getPositions()):null;}
            catch(error) {compensation.available=false;compensation.error=error.message;quality.reason='model-unavailable';}
            if(stopping||epoch!==trackingEpoch) {freshFrame=false;return null;}
            const latencyMs=performance.now()-startedAt;
            if(reply&&freshResult(frame.at,performance.now())) {
              compensation.provider=reply.provider;
              geometry.capture(pose);
              if(screenGeometry&&!manualReference&&!geometry.reference&&geometry.referenceSamples.length>=12)geometry.finishReference();
              const relative=geometry.relative(pose);
              const inRange=!geometry.reference||(relative.distanceRatio>=0.6&&relative.distanceRatio<=1.6&&Math.abs(relative.yaw)<=40&&Math.abs(relative.pitch)<=35&&Math.abs(relative.roll)<=40);
              if(!inRange) {eyesDetected=false;quality.reason='pose-out-of-range';}
              else {
                packet=screenGeometry?{
                  ray:projectToDisplay(reply.angles,eyeOrigin(pose,canvas.width,canvas.height),screenGeometry),
                  before:projectToDisplay(reply.angles,eyeOrigin(geometry.reference,canvas.width,canvas.height),screenGeometry),
                }:{ray:projectGaze(reply.angles,pose,geometry.reference),before:projectGaze(reply.angles,pose,geometry.reference,false)};
                quality={...quality,pose:relative,referenceSamples:geometry.referenceSamples.length,latencyMs,modelId:MODEL_ID,provider:reply.provider,
                  gazeYawDeg:reply.angles.yaw*180/Math.PI,gazePitchDeg:reply.angles.pitch*180/Math.PI};
                if((screenGeometry||geometry.reference)&&!packet.ray) {eyesDetected=false;quality.reason='gaze-away';}
              }
            } else {eyesDetected=false;if(quality.reason!=='model-unavailable')quality.reason=freshResult(frame.at,performance.now())?'gaze-unreliable':'stale-frame';}
            quality.latencyMs=latencyMs;
          }
        } else if(pose) quality.pose=geometry.relative(pose);
      }
      quality.frameId=frameSequence;
      quality.frameAgeMs=Math.max(0,performance.now()-frame.at);
      quality.capturedAt=performance.timeOrigin+frame.at;
      if(needsGaze&&!freshResult(frame.at,performance.now())) {
        eyesDetected=false;packet=null;quality.reason='stale-frame';
      }
      lastFeatures = eyesDetected ? features : null;
      return lastFeatures;
    } catch (error) {
      if (!stopping) parent.gazeLabEngineError(error.message, connectionId);
      return null;
    }
  };
  // The parent viewport, not the small preview iframe, defines training coordinates.
  webgazer.setGazeListener(data => {
    if (!stopping && freshFrame) {
      const pair=trackingMode==='natural'?rayModel.pair(packet,screenGeometry?.viewport):null;
      const prediction=trackingMode==='natural'?pair.prediction:data?{x:data.x,y:data.y}:null;
      parent.gazeLabFrame(eyesDetected?prediction:null,eyesDetected,connectionId,{...quality,vector:undefined,mode:trackingMode,modelId:trackingMode==='natural'?MODEL_ID:'precision-calibration-ridge',provider:trackingMode==='natural'?compensation.provider:null,before:eyesDetected?pair?.before??null:null,compensation:{...compensation}});
    }
  });
  // Preload local WASM so asset failures reject predictably before the loop starts.
  await tracker.init();
  if(stopping)throw new Error('摄像头启动已取消。');
  const solution = tracker.detector.faceMeshSolution;
  if (!solution?.setOptions) throw new Error('精细虹膜模型无法启用，请检查本地模型版本。');
  await solution.setOptions({refineLandmarks:true,minDetectionConfidence:0.6,minTrackingConfidence:0.6});
  try {
    const response=await fetch('./vendor/compensation/canonical-face.json');
    if(!response.ok)throw new Error('本地三维面部模板未能加载。');
    geometry=new FaceGeometry(await response.json());
    if(stopping)throw new Error('摄像头启动已取消。');
    pretrained=new PretrainedGaze();
    const settings=await pretrained.init();
    compensation={available:true,provider:settings.provider,error:null};
  } catch(error) {
    pretrained?.close();
    compensation={available:false,provider:null,error:error.message};
    trackingMode='precision';
  }
  // These listeners only feed implicit training. Never attach them, even during init.
  if(stopping)throw new Error('摄像头启动已取消。');
  const originalAdd = document.addEventListener.bind(document);
  document.addEventListener = (type, listener, options) => {
    if ((type === 'click' || type === 'mousemove') && options === true) return;
    originalAdd(type, listener, options);
  };
  try {
    await webgazer.begin();
  } finally {
    document.addEventListener = originalAdd;
    webgazer.removeMouseEventListeners();
  }
  return {...document.getElementById('webgazerVideoFeed')?.srcObject?.getVideoTracks()[0]?.getSettings(),compensation:{...compensation}};
}

export function configureMode(next) {
  if(next==='natural'&&!compensation.available)throw new Error('自然移动模型不可用，请选择坐稳精细模式。');
  trackingMode=next==='precision'?'precision':'natural';
  screenGeometry=null;
  clearTraining();
}
export function setScreenGeometry(profile) {
  screenGeometry=profile;
  clearTraining();
}
export function beginReference() {manualReference=true;geometry?.beginReference();}
export function finishReference() {
  if(!geometry)throw new Error('面部姿态模型不可用。');
  const result=geometry.finishReference();
  manualReference=false;
  return result;
}

export function train(x, y) {
  if (stopping || !eyesDetected) return false;
  if(lastTrained===frameSequence)return false;
  if(trackingMode==='natural') {
    if(!packet?.ray)return false;
    const accepted=rayModel.addData(packet.ray,[x,y]);
    if(accepted)lastTrained=frameSequence;
    return accepted;
  }
  const revision = regression.revision;
  webgazer.recordScreenPosition(x, y, 'click');
  const accepted=regression.revision>revision;
  if(accepted)lastTrained=frameSequence;
  return accepted;
}

export function finalizeTraining(size) {
  return trackingMode==='natural'?{...rayModel.fit(size),geometry:geometry.diagnostics(),modelId:MODEL_ID,provider:compensation.provider}:regression.fit({...size,minSamples:12});
}

export function trainingDiagnostics() {
  return trackingMode==='natural'?rayModel.diagnostics():regression.diagnostics();
}

export function clearTraining() {
  trackingEpoch++;manualReference=false;freshFrame=false;eyesDetected=false;
  webgazer.clearData();
  rayModel.init();packet=null;lastFeatures=null;lastTrained=-1;
  if(screenGeometry)geometry?.beginReference();
  else geometry?.resetReference();
}

export function stopEngine() {
  stopping = true;
  sourceVideo?.cancelVideoFrameCallback?.(videoCallback);
  pretrained?.close();
  webgazer?.pause();
  webgazer?.removeMouseEventListeners();
  document.getElementById('webgazerVideoFeed')?.srcObject?.getTracks().forEach(track => track.stop());
}

window.addEventListener('pagehide', stopEngine);
