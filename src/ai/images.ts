import {createHash} from 'node:crypto';
export interface AIImage {png:Buffer;width:number;height:number;id:string}
export function imageDescriptor(image:AIImage){
 const {png,width,height,id}=image;
 if(png.length<24||png.length>2000000||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||png.toString('ascii',12,16)!=='IHDR'||png.readUInt32BE(16)!==width||png.readUInt32BE(20)!==height||![width,height].every(n=>Number.isInteger(n)&&n>0&&n<=1568))throw Error('invalid_bounded_image');
 // Conservative unresized patch ceiling for Sol/Terra high-detail images, including rounding margin.
 return {id,width,height,sha256:createHash('sha256').update(png).digest('hex'),detail:'high' as const,tokens:Math.ceil(Math.ceil(width/32)*Math.ceil(height/32)*1.2)+1};
}
