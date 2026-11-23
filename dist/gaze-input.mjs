export const MODEL_ID='mobilegaze-mobileone-s0-gaze360';
export const INPUT_SIZE=448;
export function faceBounds(landmarks,width,height) {
  const points=landmarks?.slice(0,468);
  if(points?.length!==468||points.some(p=>!Number.isFinite(p?.[0])||!Number.isFinite(p?.[1]))) return null;
  const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
  const left=Math.min(...xs),right=Math.max(...xs),top=Math.min(...ys),bottom=Math.max(...ys);
  const padx=(right-left)*0.05,pady=(bottom-top)*0.05;
  const x=Math.max(0,Math.floor(left-padx)),y=Math.max(0,Math.floor(top-pady));
  const w=Math.min(width,Math.ceil(right+padx))-x,h=Math.min(height,Math.ceil(bottom+pady))-y;
  return w>=32&&h>=32?{x,y,width:w,height:h}:null;
}
export function normalizeRgba(data) {
  const pixels=data.length/4,output=new Float32Array(pixels*3);
  const mean=[0.485,0.456,0.406],std=[0.229,0.224,0.225];
  for(let c=0;c<3;c++) for(let i=0;i<pixels;i++) output[c*pixels+i]=(data[i*4+c]/255-mean[c])/std[c];
  return output;
}
export function decodeAngles(yawLogits,pitchLogits) {
  const decode=values=>{
    if(values?.length!==90||!Array.from(values).every(Number.isFinite)) throw new Error('预训练模型角度输出无效。');
    const max=Math.max(...values),weights=Array.from(values,v=>Math.exp(v-max)),total=weights.reduce((a,b)=>a+b,0);
    return (weights.reduce((sum,v,i)=>sum+v*i,0)/total*4-180)*Math.PI/180;
  };
  return {yaw:decode(yawLogits),pitch:decode(pitchLogits)};
}
export function freshResult(startedAt,now,maxAge=250) {return Number.isFinite(startedAt)&&Number.isFinite(now)&&now>=startedAt&&now-startedAt<=maxAge;}
