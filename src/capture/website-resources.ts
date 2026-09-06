import {safeRead} from './fetch';

type Response=Awaited<ReturnType<typeof safeRead>>;
type Pending={url:string;kind:string;resolve:(value:Response)=>void;reject:(error:Error)=>void};
const priority=(kind:string)=>kind==='font'?1:kind==='image'?2:0;

/** Reserve collection capacity for content, scripts and styles before optional assets. */
export function websiteResources(document:Response,robotsBytes:number,signal:AbortSignal){
 const cache=new Map<string,Promise<Response>>([[document.url,Promise.resolve(document)]]),queue:Pending[]=[];
 const skipped=new Set<string>(),optionalCounts={font:0,image:0};
 let active=0,reservedBytes=0,optionalAllowed=false;
 const stats={requests:2,bytes:robotsBytes+document.bytes.length};
 function pump(){
  queue.sort((a,b)=>priority(a.kind)-priority(b.kind));
  while(active<2&&queue.length){
   if(!optionalAllowed&&priority(queue[0].kind)>0)return;
   const item=queue.shift()!;
   if(signal.aborted){item.reject(Error('capture_deadline'));continue;}
   const remaining=10000000-stats.bytes-reservedBytes;
   if(stats.requests>=50||remaining<=0){item.reject(Error('capture_request_limit'));continue;}
   const optional=priority(item.kind)>0,allowance=Math.min(optional?250000:1000000,remaining);
   stats.requests++;active++;reservedBytes+=allowance;
   // Optional reads cannot occupy both slots for the full critical-resource timeout.
   const readSignal=optional?AbortSignal.any([signal,AbortSignal.timeout(1500)]):signal;
   void safeRead(item.url,allowance,readSignal).then(value=>{stats.bytes+=value.bytes.length;item.resolve(value);},item.reject).finally(()=>{active--;reservedBytes-=allowance;pump();});
  }
 }
 signal.addEventListener('abort',()=>{for(const item of queue.splice(0))item.reject(Error('capture_deadline'));},{once:true});
 return {
  stats,skipped,
  releaseOptional(){optionalAllowed=true;pump();},
  read(url:string,kind:string):Promise<Response>{
   const saved=cache.get(url);if(saved)return saved;
   if(signal.aborted)return Promise.reject(Error('capture_deadline'));
   if(kind==='image'||kind==='font'){
    if(optionalCounts[kind]>=4){skipped.add(`${kind}:${url}`);return Promise.reject(Error('capture_optional_limit'));}
    optionalCounts[kind]++;
   }
   const result=new Promise<Response>((resolve,reject)=>queue.push({url,kind,resolve,reject}));
   cache.set(url,result);pump();return result;
  }
 };
}
