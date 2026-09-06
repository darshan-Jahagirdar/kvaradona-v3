import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {z} from 'zod';
import {serviceClient} from './client';
import {WebsiteCapture} from '../contracts/website';
import {captureWebsiteEvidence} from '../capture/website';
import {imageDescriptor,type AIImage} from '../ai/images';
import {hash} from '../domain/policy';
const bucket='website-captures';
export function capturePath(organizationId:string,captureId:string,viewport:'mobile'|'desktop'){
 return `${z.string().uuid().parse(organizationId)}/${z.string().uuid().parse(captureId)}/${viewport}.png`;
}
export async function storeWebsiteCapture(url:string,host:string,organizationId:string,key:string){
 const directory=resolve('.local','website-captures',hash({organizationId,key,url,host}));await mkdir(directory,{recursive:true});
 let capture:WebsiteCapture,images:AIImage[];
 try{
  capture=WebsiteCapture.parse(JSON.parse(await readFile(resolve(directory,'capture.json'),'utf8')));
  images=await Promise.all(capture.screenshots.map(async s=>({id:s.viewport,width:s.width,height:s.height,png:await readFile(resolve(directory,s.viewport+'.png'))})));
 }catch(error){
  if(!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw error;
  const result=await captureWebsiteEvidence(url,host);capture=result.capture;images=result.images;
  for(const i of images)await writeFile(resolve(directory,i.id+'.png'),i.png,{mode:0o600});
  await writeFile(resolve(directory,'capture.json'),JSON.stringify(capture),{mode:0o600});
 }
 const client=serviceClient();
 for(const i of images){
  const descriptor=imageDescriptor(i),artifact=capture.screenshots.find(s=>s.viewport===i.id)!;
  if(descriptor.sha256!==artifact.sha256)throw Error('capture_artifact_mismatch');
  const path=capturePath(organizationId,capture.id,artifact.viewport);artifact.path=path;
  const {error}=await client.storage.from(bucket).upload(path,i.png,{contentType:'image/png',upsert:false});
  if(error){
   // Lost upload acknowledgement: read back and compare; never overwrite evidence.
   const {data,error:readError}=await client.storage.from(bucket).download(path);
   if(readError||!data||createHash('sha256').update(Buffer.from(await data.arrayBuffer())).digest('hex')!==artifact.sha256)throw Error('capture_upload_failed');
  }
 }
 return capture;
}
export async function loadWebsiteImages(capture:WebsiteCapture,organizationId:string):Promise<AIImage[]>{
 const client=serviceClient();
 return Promise.all(capture.screenshots.map(async s=>{
  if(s.path!==capturePath(organizationId,capture.id,s.viewport))throw Error('capture_artifact_scope_mismatch');
  const {data,error}=await client.storage.from(bucket).download(s.path);if(error||!data||data.size>2000000)throw Error('capture_artifact_unavailable');
  const image={id:s.viewport,width:s.width,height:s.height,png:Buffer.from(await data.arrayBuffer())};
  if(imageDescriptor(image).sha256!==s.sha256)throw Error('capture_artifact_mismatch');return image;
 }));
}
