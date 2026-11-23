import {CalibrationRidge} from './regression.mjs';
export class RayCalibration extends CalibrationRidge {
  init() {super.init();this.name='mobilegaze-ray-affine';}
  fit({minSamples=8,...options}) {return super.fit({...options,minSamples,lambda:0.001});}
  pair(packet, viewport) {
    const map = point => {
      if (!point) return null;
      if (this.frozen) return this.predict(point);
      return viewport ? {x:point[0]*viewport.width,y:point[1]*viewport.height} : null;
    };
    return {prediction:map(packet?.ray),before:map(packet?.before)};
  }
}
