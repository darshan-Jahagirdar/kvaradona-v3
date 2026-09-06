import {safeRead} from './fetch';
import {websiteLimits as limits} from './website-limits';

type Response=Awaited<ReturnType<typeof safeRead>>;
type Pending={url:string;kind:string;resolve:(value:Response)=>void;reject:(error:Error)=>void};
const priority=(kind:string)=>kind==='font'?1:kind==='image'?2:0;

/** Reserve collection capacity for content, scripts and styles before optional assets. */
export function websiteResources(document:Response,robotsBytes:number,signal:AbortSignal){
 const cache=new Map<string,Promise<Response>>([[document.url,Promise.resolve(document)]]),queue:Pending[]=[];
 const skipped=new Set<string>(),optionalCounts={font:0,image:0};
 let active=0,optionalActive=0,reservedBytes=0;
 const stats={requests:2,bytes:robotsBytes+document.bytes.length};
 function pump(){
  queue.sort((a,b)=>priority(a.kind)-priority(b.kind));
  while(active<limits.concurrent&&queue.length){
   if(priority(queue[0].kind)>0&&optionalActive>=limits.optionalConcurrent)return;
   const item=queue.shift()!;
   if(signal.aborted){item.reject(Error('capture_deadline'));continue;}
   const remaining=limits.bytes-stats.bytes-reservedBytes;
   if(stats.requests>=limits.requests||remaining<=0){item.reject(Error('capture_request_limit'));continue;}
   const optional=priority(item.kind)>0,allowance=Math.min(optional?limits.optionalBytes:limits.criticalBytes,remaining);
   stats.requests++;active++;if(optional)optionalActive++;reservedBytes+=allowance;
   // Optional reads cannot occupy the four slots reserved for critical dependencies.
   const readSignal=optional?AbortSignal.any([signal,AbortSignal.timeout(limits.optionalMs)]):signal;
   void safeRead(item.url,allowance,readSignal,optional?limits.optionalMs:30000).then(value=>{stats.bytes+=value.bytes.length;item.resolve(value);},item.reject).finally(()=>{active--;if(optional)optionalActive--;reservedBytes-=allowance;pump();});
  }
 }
 signal.addEventListener('abort',()=>{for(const item of queue.splice(0))item.reject(Error('capture_deadline'));},{once:true});
 return {
  stats,skipped,
  get pending(){return active+queue.length;},
  read(url:string,kind:string):Promise<Response>{
   const saved=cache.get(url);if(saved)return saved;
   if(signal.aborted)return Promise.reject(Error('capture_deadline'));
   if(kind==='image'||kind==='font'){
    if(optionalCounts[kind]>=(kind==='image'?limits.images:limits.fonts)){skipped.add(`${kind}:${url}`);return Promise.reject(Error('capture_optional_limit'));}
    optionalCounts[kind]++;
   }
   const result=new Promise<Response>((resolve,reject)=>queue.push({url,kind,resolve,reject}));
   cache.set(url,result);pump();return result;
  }
 };
}
