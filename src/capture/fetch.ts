import { lookup } from 'node:dns/promises';
import { BlockList,isIP } from 'node:net';
import { Agent,request } from 'undici';
import { load } from 'cheerio';
import { randomUUID } from 'node:crypto';
import { hash,hostOf,firstPartyATS } from '../domain/policy';
import type { Evidence } from '../contracts/pipeline';
import {getDomain} from 'tldts';
import {robotsAllows} from './robots';
import {SourceReadError,sourceFailure,type SourceAttempt} from './source-error';
export {robotsAllows} from './robots';
const blocked=new BlockList();
for(const [ip,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)blocked.addSubnet(ip,prefix,'ipv4');
export function publicAddress(ip:string){if(isIP(ip)===4)return !blocked.check(ip,'ipv4');return isIP(ip)===6&&/^[23][0-9a-f]{3}:/i.test(ip)&&!ip.toLowerCase().startsWith('2001:db8:');}
export async function publicUrl(input:string){
 const url=new URL(input);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||(url.port&&!['80','443'].includes(url.port)))throw new Error('unsafe_url');
 const addresses=await lookup(url.hostname,{all:true});if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new Error('unsafe_destination');return {url,addresses};
}
export async function safeRead(input:string,limit=1000000,signal?:AbortSignal,timeoutMs=12000,kind:'document'|'robots'='document'){
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('invalid_read_timeout');
 let current=input;
 for(let i=0;i<4;i++){
  const {url,addresses}=await publicUrl(current);const pinned=addresses[0];
  // Pin the validated address through connect; DNS rebinding cannot reach a private destination.
  const agent=new Agent({connect:{lookup:(_hostname,_options,callback)=>callback(null,[pinned])}});
  try{
   const response=await request(url,{dispatcher:agent,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs),headers:{'user-agent':'KvaradonaResearch/0.1 (+evidence review)','accept':'*/*'},headersTimeout:Math.min(30000,timeoutMs),bodyTimeout:Math.min(30000,timeoutMs)});
   const discard=()=>{response.body.on('error',()=>{});response.body.destroy();};
   if(response.statusCode>=300&&response.statusCode<400){const location=response.headers.location;discard();if(!location||Array.isArray(location))throw new Error('redirect_missing');current=new URL(location,url).toString();continue;}
   const contentType=String(response.headers['content-type']??'');
   if(kind==='robots'&&response.statusCode!==200){discard();return {url:url.href,status:response.statusCode,contentType,robotsHeader:'',text:'',bytes:Buffer.alloc(0)};}
   if(kind==='robots'&&/html/i.test(contentType)){discard();throw new SourceReadError({url:url.origin+url.pathname,stage:'robots',code:'robots_invalid_format',status:response.statusCode});}
   const chunks:Buffer[]=[];let size=0;for await(const chunk of response.body){const b=Buffer.from(chunk);size+=b.length;if(size>limit)throw new Error('document_size_limit');chunks.push(b);}
   return {url:url.toString(),status:response.statusCode,contentType:String(response.headers['content-type']??''),robotsHeader:String(response.headers['x-robots-tag']??''),text:Buffer.concat(chunks).toString('utf8'),bytes:Buffer.concat(chunks)};
  }finally{await agent.close();}
 }
 throw new Error('redirect_limit');
}
export async function fetchEvidence(input:string,onAttempt?:(attempt:SourceAttempt)=>void):Promise<Evidence>{
 let u=new URL(input);
 for(let attempt=0;attempt<2;attempt++){
  const robotsUrl=new URL('/robots.txt',u).href;
  try{
   const robots=await safeRead(robotsUrl,128000,undefined,12000,'robots');
   if(robots.status>=500||robots.status===429)throw new SourceReadError({url:robotsUrl,stage:'robots',code:'robots_unavailable',status:robots.status});
   if(robots.status===200&&/^\s*(?:<!doctype html|<html)/i.test(robots.text))throw Error('robots_invalid_format');
   if(robots.status===200&&!robotsAllows(robots.text,u.pathname+u.search))throw Error('robots_disallowed');
   break;
  }catch(error){
   const detail=sourceFailure(error,robotsUrl,'robots');onAttempt?.(detail);
   // Only retry an apex on its canonical www host, before reading the page.
   // Never bypass a robots denial, unsafe destination, timeout or HTTP rate limit.
   if(attempt===0&&getDomain(u.hostname,{allowPrivateDomains:true})===u.hostname&&['robots_invalid_format','UNABLE_TO_VERIFY_LEAF_SIGNATURE','CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID'].includes(detail.code)){u=new URL(u);u.hostname='www.'+u.hostname;continue;}
   throw new SourceReadError(detail);
  }
 }
 try{
  const r=await safeRead(u.href);if(r.status!==200)throw new SourceReadError({url:new URL(r.url).origin+new URL(r.url).pathname,stage:'page',code:`source_http_${r.status}`,status:r.status});
  if(!/html|text\/plain/.test(r.contentType))throw Error('source_format_not_supported');
  const evidence=extractEvidence(input,r.url,r.text);onAttempt?.({url:new URL(r.url).origin+new URL(r.url).pathname,stage:'page',code:'ok',status:r.status});return evidence;
 }catch(error){throw new SourceReadError(sourceFailure(error,u.href,'page'));}
}
const boardHost=(host:string)=>/(^|\.)(ashbyhq\.com|greenhouse\.io|lever\.co|jobleads\.com|bebee\.com|revopsroles\.com|linkedin\.com|indeed\.com)$/.test(host);
/** Extract structured employer attribution before removing scripts; the publishing board is never the buyer. */
export function extractEvidence(input:string,finalUrl:string,html:string,now=new Date()):Evidence{
 const $=load(html),publisher=hostOf(finalUrl);let job:Record<string,unknown>|undefined;
 function inspect(value:unknown){
  if(Array.isArray(value)){for(const item of value)inspect(item);return;}
  if(!value||typeof value!=='object')return;const v=value as Record<string,unknown>;
  if(v['@type']==='JobPosting'||(Array.isArray(v['@type'])&&v['@type'].includes('JobPosting')))job??=v;
  if(v['@graph'])inspect(v['@graph']);
 }
 $('script[type="application/ld+json"]').each((_i,e)=>{try{inspect(JSON.parse($(e).text()));}catch{/* Malformed metadata cannot establish identity. */}});
 const organization=job?.hiringOrganization&&typeof job.hiringOrganization==='object'?job.hiringOrganization as Record<string,unknown>:undefined;
 const organizationName=typeof organization?.name==='string'?organization.name:null;
 let organizationUrl=typeof organization?.sameAs==='string'?organization.sameAs:typeof organization?.url==='string'?organization.url:null;
 if(!organizationUrl&&organizationName&&firstPartyATS(publisher)){
  const links=$('a[href]').toArray().filter(a=>{const label=$(a).text().trim().toLowerCase();return label.startsWith(organizationName.toLowerCase())&&/home\s?page|website/.test(label);}).map(a=>$(a).attr('href')!).filter(Boolean);
  if(new Set(links).size===1)organizationUrl=new URL(links[0],finalUrl).href;
 }
 let accountHost:string|null=boardHost(publisher)?null:publisher;
 if(firstPartyATS(publisher)&&organizationName&&organizationUrl){try{const u=new URL(organizationUrl);if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!boardHost(hostOf(u.href)))accountHost=hostOf(u.href);}catch{/* Identity stays unresolved. */}}
 const metadata=job?[typeof job.title==='string'?job.title:'',organizationName?`Hiring organization: ${organizationName}.`:'',organizationUrl?`Organization URL: ${organizationUrl}`:'',typeof job.datePosted==='string'?`Date posted: ${job.datePosted}`:'',typeof job.description==='string'?load(job.description).text():''].filter(Boolean).join('\n'):'';
 const published=typeof job?.datePosted==='string'?job.datePosted:$('meta[property="article:published_time"]').attr('content')??$('time[datetime]').first().attr('datetime')??null;
 const expiry=typeof job?.validThrough==='string'?Date.parse(job.validThrough):NaN;
 $('script,style,noscript,nav,footer,header').remove();
 const root=$('main').length?$('main'):$('body');const text=[metadata,root.text()].filter(Boolean).join('\n').replace(/\s+/g,' ').trim().slice(0,18000);
 if(text.length<120)throw new Error('source_text_insufficient');
 return {id:randomUUID(),url:input,finalUrl,title:$('title').text().trim()||(typeof job?.title==='string'?job.title:''),text,contentHash:hash(text),retrievedAt:now.toISOString(),publishedAt:published,source:job?'job_posting_web':'original_web',origin:boardHost(publisher)&&!firstPartyATS(publisher)?'provider_reported':'original',status:Number.isFinite(expiry)&&expiry<now.getTime()?'closed':'unknown',accountHost};
}
