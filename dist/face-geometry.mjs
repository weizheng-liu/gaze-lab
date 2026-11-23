// Weak-perspective fit. Scale and angles are estimates relative to calibration.
export const RIGID_INDICES = [1,4,6,10,21,33,54,58,67,93,103,109,127,132,133,136,152,168,172,197,234,251,263,284,288,297,323,332,338,356,361,362,365,397,454];
const dot = (a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
const sub = (a,b)=>a.map((v,i)=>v-b[i]);
const norm = a=>Math.hypot(...a);
const transpose = a=>[a[0],a[3],a[6],a[1],a[4],a[7],a[2],a[5],a[8]];
export const rotate = (r,p)=>[dot(r.slice(0,3),p),dot(r.slice(3,6),p),dot(r.slice(6,9),p)];
export function multiply(a,b) {
  return Array.from({length:9},(_,i)=>[0,1,2].reduce((s,k)=>s+a[Math.floor(i/3)*3+k]*b[k*3+i%3],0));
}

// Jacobi eigensolver avoids the sign ambiguity of power iteration on Horn's matrix.
function largestEigenvector(matrix) {
  const a=matrix.map(row=>[...row]), v=Array.from({length:4},(_,i)=>Array.from({length:4},(_,j)=>+(i===j)));
  for(let iteration=0;iteration<80;iteration++) {
    let p=0,q=1;
    for(let i=0;i<4;i++) for(let j=i+1;j<4;j++) if(Math.abs(a[i][j])>Math.abs(a[p][q])) {p=i;q=j;}
    if(Math.abs(a[p][q])<1e-12) break;
    const angle=0.5*Math.atan2(2*a[p][q],a[q][q]-a[p][p]), c=Math.cos(angle),s=Math.sin(angle);
    const app=a[p][p],aqq=a[q][q],apq=a[p][q];
    a[p][p]=c*c*app-2*s*c*apq+s*s*aqq;
    a[q][q]=s*s*app+2*s*c*apq+c*c*aqq; a[p][q]=a[q][p]=0;
    for(let k=0;k<4;k++) {
      if(k!==p&&k!==q) {const x=a[k][p],y=a[k][q];a[k][p]=a[p][k]=c*x-s*y;a[k][q]=a[q][k]=s*x+c*y;}
      const x=v[k][p],y=v[k][q];v[k][p]=c*x-s*y;v[k][q]=s*x+c*y;
    }
  }
  let index=0; for(let i=1;i<4;i++) if(a[i][i]>a[index][index]) index=i;
  return v.map(row=>row[index]);
}

export function similarityFit(source,target) {
  if(source.length!==target.length||source.length<6||[...source,...target].some(p=>p?.length!==3||!p.every(Number.isFinite))) return null;
  const mean=points=>[0,1,2].map(i=>points.reduce((s,p)=>s+p[i],0)/points.length);
  const a=mean(source), b=mean(target), x=source.map(p=>sub(p,a)),y=target.map(p=>sub(p,b));
  const covariance=Array.from({length:3},(_,i)=>Array.from({length:3},(_,j)=>x.reduce((s,p,k)=>s+p[i]*y[k][j],0)));
  const [[xx,xy,xz],[yx,yy,yz],[zx,zy,zz]]=covariance;
  const [w,qx,qy,qz]=largestEigenvector([[xx+yy+zz,yz-zy,zx-xz,xy-yx],[yz-zy,xx-yy-zz,xy+yx,zx+xz],[zx-xz,xy+yx,-xx+yy-zz,yz+zy],[xy-yx,zx+xz,yz+zy,-xx-yy+zz]]);
  const rotation=[1-2*(qy*qy+qz*qz),2*(qx*qy-qz*w),2*(qx*qz+qy*w),2*(qx*qy+qz*w),1-2*(qx*qx+qz*qz),2*(qy*qz-qx*w),2*(qx*qz-qy*w),2*(qy*qz+qx*w),1-2*(qx*qx+qy*qy)];
  const denominator=x.reduce((sum,p)=>sum+dot(p,p),0);
  if(denominator<1e-9) return null;
  const scale=x.reduce((sum,p,i)=>sum+dot(rotate(rotation,p),y[i]),0)/denominator;
  if(!(scale>0)) return null;
  const translation=sub(b,rotate(rotation,a).map(v=>v*scale));
  const residual=Math.sqrt(x.reduce((sum,p,i)=>sum+norm(sub(rotate(rotation,p).map(v=>v*scale),y[i]))**2,0)/(scale*scale*denominator));
  return {rotation,scale,translation,residual};
}

export class FaceGeometry {
  constructor(template) {
    if(template.length!==468) throw new Error('本地三维面部模板不完整。');
    // Canonical y-up/z-forward -> image y-down/z-away (a proper rotation).
    this.source=RIGID_INDICES.map(i=>[template[i][0],-template[i][1],-template[i][2]]);
    this.resetReference();
  }
  resetReference() {this.reference=null;this.referenceSamples=[];this.collecting=false;}
  beginReference() {this.resetReference();this.collecting=true;}
  estimate(landmarks,width,height) {
    const fitted=similarityFit(this.source,RIGID_INDICES.map(i=>landmarks?.[i]));
    if(!fitted||fitted.residual>0.25) return null;
    // Use eye corners so looking around does not move the estimated ray origin.
    const centers=[33,133,362,263].map(i=>landmarks?.[i]);
    if(centers.some(p=>!p||!p.slice(0,2).every(Number.isFinite))) return null;
    const eyeCenter=[0,1].map(axis=>centers.reduce((sum, point)=>sum+point[axis],0)/centers.length);
    const focal=Math.max(width,height);
    const eye=[(eyeCenter[0]-width/2)/focal,(eyeCenter[1]-height/2)/focal];
    return {...fitted,eye};
  }
  capture(pose) {if(this.collecting&&pose&&this.referenceSamples.length<120)this.referenceSamples.push(pose);}
  finishReference() {
    if(this.referenceSamples.length<12) throw new Error('参考坐姿样本不足，请让双眼清晰入镜后重试。');
    const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
    const scale=median(this.referenceSamples.map(p=>p.scale));
    const representative=[...this.referenceSamples].sort((a,b)=>Math.abs(a.scale-scale)-Math.abs(b.scale-scale))[0];
    this.reference={scale,rotation:[...representative.rotation],eye:[0,1].map(i=>median(this.referenceSamples.map(p=>p.eye[i])))};
    this.collecting=false;
    return this.diagnostics();
  }
  relative(pose) {
    if(!pose) return null;
    const rotation=this.reference?multiply(pose.rotation,transpose(this.reference.rotation)):pose.rotation;
    const degree=180/Math.PI;
    const yaw=Math.asin(Math.max(-1,Math.min(1,-rotation[6])))*degree;
    const pitch=Math.atan2(rotation[7],rotation[8])*degree,roll=Math.atan2(rotation[3],rotation[0])*degree;
    const distanceRatio=this.reference?this.reference.scale/pose.scale:null;
    return {yaw,pitch,roll,distanceRatio,fitError:pose.residual};
  }
  diagnostics() {
    return {referenceSamples:this.referenceSamples.length,reference:this.reference,method:'canonical-3d-similarity',distanceUnits:'ratio to reference',angleUnits:'degrees relative to reference'};
  }
}

// Model angles are already in the camera frame; do not rotate them a second time.
export function gazeVector(yaw,pitch) {
  return [-Math.cos(pitch)*Math.sin(yaw),-Math.sin(pitch),-Math.cos(pitch)*Math.cos(yaw)];
}
export function projectGaze(gaze,pose,reference,compensate=true) {
  if(!pose||!reference||![gaze?.yaw,gaze?.pitch].every(Number.isFinite)) return null;
  const vector=gazeVector(gaze.yaw,gaze.pitch);
  if(vector[2]>-0.25) return null;
  const distance=compensate?reference.scale/pose.scale:1;
  const eye=compensate?pose.eye:reference.eye;
  const ray=[distance*(eye[0]-vector[0]/vector[2]),distance*(eye[1]-vector[1]/vector[2])];
  return ray.every(Number.isFinite)?ray:null;
}

// Convert the pose-adjusted template scale (pixels per canonical centimeter)
// to an approximate depth. Head size and focal length vary by person/device.
export function eyeOrigin(pose, width, height) {
  const depth = Math.max(width,height) / pose?.scale;
  if (!(depth>0) || !Number.isFinite(depth) || !pose.eye.every(Number.isFinite)) return null;
  return [pose.eye[0]*depth,pose.eye[1]*depth,depth];
}

export function projectToDisplay(gaze, origin, display) {
  if (!origin || ![...origin,gaze?.yaw,gaze?.pitch].every(Number.isFinite) || !(origin[2]>0)) return null;
  const direction=gazeVector(gaze.yaw,gaze.pitch);
  if (direction[2]>-0.25) return null;
  const travel=-origin[2]/direction[2];
  const u=(origin[0]+travel*direction[0]+display.cameraXCm)/display.widthCm;
  const v=(origin[1]+travel*direction[1]+display.cameraYCm)/display.heightCm;
  return [u,v].every(Number.isFinite)?[u,v]:null;
}
