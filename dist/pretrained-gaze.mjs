import {INPUT_SIZE,faceBounds,normalizeRgba,MODEL_ID} from './gaze-input.mjs';
export class PretrainedGaze {
  constructor() {this.pending=new Map();this.nextId=0;this.busy=false;this.closed=false;this.provider=null;}
  async init({forceWasm=false}={}) {
    this.worker=new Worker(new URL('./gaze-worker.mjs',import.meta.url),{type:'module'});
    this.worker.onmessage=({data})=>{
      const item=this.pending.get(data.id);if(!item)return;
      this.pending.delete(data.id);clearTimeout(item.timeout);
      data.error?item.reject(new Error(data.error)):item.resolve(data);
    };
    this.worker.onerror=()=>this.close(new Error('离线视线模型运行失败。'));
    const reply=await this.request({type:'init',forceWasm},[],45000);
    this.provider=reply.provider;
    this.canvas=new OffscreenCanvas(INPUT_SIZE,INPUT_SIZE);
    this.context=this.canvas.getContext('2d',{willReadFrequently:true});
    return {modelId:MODEL_ID,provider:this.provider};
  }
  request(body,transfer=[],wait=10000) {
    if(this.closed)return Promise.reject(new Error('视线模型已停止。'));
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{this.pending.delete(id);reject(new Error('离线视线模型响应超时。'));},wait);
      this.pending.set(id,{resolve,reject,timeout});this.worker.postMessage({...body,id},transfer);
    });
  }
  async predict(source,landmarks) {
    if(this.busy||this.closed)return null;
    const box=faceBounds(landmarks,source.width,source.height);if(!box)return null;
    this.busy=true;
    try {
      this.context.drawImage(source,box.x,box.y,box.width,box.height,0,0,INPUT_SIZE,INPUT_SIZE);
      const input=normalizeRgba(this.context.getImageData(0,0,INPUT_SIZE,INPUT_SIZE).data);
      const reply=await this.request({type:'infer',input},[input.buffer]);
      this.provider=reply.provider;return reply;
    } finally {this.busy=false;}
  }
  close(error=new Error('视线模型已停止。')) {
    this.closed=true;this.worker?.terminate();
    for(const item of this.pending.values()) {clearTimeout(item.timeout);item.reject(error);}
    this.pending.clear();
  }
}
