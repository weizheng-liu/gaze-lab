import {decodeAngles,INPUT_SIZE} from './gaze-input.mjs';
const base=new URL('./vendor/compensation/',import.meta.url);
let ort,session,provider;
async function create(providerName) {
  const filename=providerName==='webgpu'?'ort.webgpu.bundle.min.mjs':'ort.wasm.bundle.min.mjs';
  ort=await import(new URL(`ort/${filename}`,base).href);
  ort.env.wasm.numThreads=1;
  ort.env.wasm.wasmPaths=new URL('ort/',base).href;
  ort.env.logLevel='error';
  session=await ort.InferenceSession.create(new URL('mobileone_s0_gaze.onnx',base).href,{executionProviders:[providerName],graphOptimizationLevel:'all'});
  provider=providerName;
  await run(new Float32Array(3*INPUT_SIZE*INPUT_SIZE));
}
async function run(input) {
  const tensor=new ort.Tensor('float32',input,[1,3,INPUT_SIZE,INPUT_SIZE]);
  let outputs;
  try {
    outputs=await session.run({[session.inputNames[0]]:tensor});
    return decodeAngles(outputs.yaw?.data,outputs.pitch?.data);
  } finally {tensor.dispose();if(outputs)Object.values(outputs).forEach(t=>t.dispose());}
}
self.onmessage=async({data})=>{
  try {
    if(data.type==='init') {
      if(navigator.gpu&&!data.forceWasm) {
        try {await create('webgpu');} catch {await session?.release();session=null;await create('wasm');}
      } else await create('wasm');
      self.postMessage({id:data.id,provider});
    } else if(data.type==='infer') {
      const started=performance.now();
      let angles;
      try {angles=await run(data.input);} catch(error) {
        if(provider!=='webgpu') throw error;
        await session?.release();session=null;await create('wasm');angles=await run(data.input);
      }
      self.postMessage({id:data.id,angles,provider,inferenceMs:performance.now()-started});
    }
  } catch(error) {self.postMessage({id:data.id,error:error.message||String(error)});}
};
