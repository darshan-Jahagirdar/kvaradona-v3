import {structuredFactStatement} from '../domain/structured-evidence';
import { lookup } from 'node:dns/promises';
import { BlockList,isIP } from 'node:net';
import { Agent,request } from 'undici';
import { load } from 'cheerio';
import { randomUUID } from 'node:crypto';
import { hash,hostOf,firstPartyATS } from '../domain/policy';
import type { Evidence } from '../contracts/pipeline';
import {getDomain} from 'tldts';
import {robotsAllows} from './robots';
import {publicContentBody} from './public-content';
import {SourceReadError,sourceFailure,type SourceAttempt} from './source-error';
export {robotsAllows} from './robots';
const blocked=new BlockList();
for(const [ip,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)blocked.addSubnet(ip,prefix,'ipv4');
export function publicAddress(ip:string){if(isIP(ip)===4)return !blocked.check(ip,'ipv4');return isIP(ip)===6&&/^[23][0-9a-f]{3}:/i.test(ip)&&!ip.toLowerCase().startsWith('2001:db8:');}
export async function publicUrl(input:string){
 const url=new URL(input);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||(url.port&&!['80','443'].includes(url.port)))throw new Error('unsafe_url');
 const addresses=await lookup(url.hostname,{all:true});if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new Error('unsafe_destination');return {url,addresses};
}
export async function safeRead(input:string,limit=1000000,signal?:AbortSignal,timeoutMs=12000,kind:'document'|'robots'='document',contentBody?:string){
 if(contentBody&&!publicContentBody(input,new URL(input).origin,'POST',contentBody))throw Error('public_content_read_required');
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('invalid_read_timeout');
 let current=input;
 for(let i=0;i<4;i++){
  const {url,addresses}=await publicUrl(current);const pinned=addresses[0];
  // Pin the validated address through connect; DNS rebinding cannot reach a private destination.
  const agent=new Agent({connect:{lookup:(_hostname,_options,callback)=>callback(null,[pinned])}});
  try{
   const response=await request(url,{method:contentBody?'POST':'GET',body:contentBody,dispatcher:agent,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs),headers:{'user-agent':'KvaradonaResearch/0.1 (+evidence review)','accept':'*/*',...(contentBody?{'content-type':'application/json'}:{})},headersTimeout:Math.min(30000,timeoutMs),bodyTimeout:Math.min(30000,timeoutMs)});
   const discard=()=>{response.body.on('error',()=>{});response.body.destroy();};
   if(response.statusCode>=300&&response.statusCode<400){const location=response.headers.location;discard();if(contentBody)throw Error('public_content_redirect');if(!location||Array.isArray(location))throw new Error('redirect_missing');current=new URL(location,url).toString();continue;}
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
   if(robots.status===200&&!robotsAllows(robots.text,u.pathname+u.search))throw new SourceReadError({url:u.href,stage:'robots',code:'robots_disallowed'});
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
  let r;try{r=await safeRead(u.href);}catch(error){if(!(error instanceof Error)||error.message!=='document_size_limit')throw error;onAttempt?.({url:u.href,stage:'page',code:'retry_larger_document'});r=await safeRead(u.href,4000000,undefined,30000);}
  if(r.status!==200)throw new SourceReadError({url:new URL(r.url).origin+new URL(r.url).pathname,stage:'page',code:`source_http_${r.status}`,status:r.status});
  if(!/html|text\/plain/.test(r.contentType))throw Error('source_format_not_supported');
  let evidence:Evidence;
  try{evidence=extractEvidence(input,r.url,r.text);}
  catch(error){
   if(!(error instanceof Error)||error.message!=='source_text_insufficient')throw error;
   const {captureWebsiteEvidence}=await import('./website');
   const rendered=await captureWebsiteEvidence(r.url,hostOf(r.url));
   if(!rendered.renderedHtml)throw Error('source_text_insufficient');
   evidence={...extractEvidence(input,rendered.capture.finalUrl,rendered.renderedHtml),title:rendered.capture.facts.find(f=>f.id==='page_title')?.text??'',source:'original_web_rendered'};
   onAttempt?.({url:new URL(r.url).origin+new URL(r.url).pathname,stage:'page',code:'rendered_context_recovered',status:200});
  }
  onAttempt?.({url:new URL(r.url).origin+new URL(r.url).pathname,stage:'page',code:'ok',status:r.status});return evidence;
 }catch(error){throw new SourceReadError(sourceFailure(error,u.href,'page'));}
}
const boardHost=(host:string)=>/(^|\.)(ashbyhq\.com|greenhouse\.io|lever\.co|jobleads\.com|bebee\.com|revopsroles\.com|linkedin\.com|indeed\.com)$/.test(host);
/** Extract structured employer attribution before removing scripts; the publishing board is never the buyer. */
export function extractEvidence(input:string,finalUrl:string,html:string,now=new Date()):Evidence{
 const $=load(html),publisher=hostOf(finalUrl);
 type Node={value:Record<string,unknown>;sourceId:string;pointer:string};
 const structuredSources:NonNullable<Evidence['structuredSources']>=[],organizations:Node[]=[];let job:Node|undefined,article:Node|undefined,total=0;
 function inspect(value:unknown,sourceId:string,pointer=''){
  if(Array.isArray(value)){value.forEach((v,i)=>inspect(v,sourceId,pointer+'/'+i));return;}
  if(!value||typeof value!=='object')return;const v=value as Record<string,unknown>,node={value:v,sourceId,pointer};
  if(v['@type']==='Organization')organizations.push(node);
  if(v['@type']==='JobPosting'||Array.isArray(v['@type'])&&v['@type'].includes('JobPosting'))job??=node;
  if(['NewsArticle','Article','PressRelease'].some(t=>v['@type']===t||Array.isArray(v['@type'])&&v['@type'].includes(t)))article??=node;
  if(v['@graph'])inspect(v['@graph'],sourceId,pointer+'/@graph');
 }
 $('script[type="application/ld+json"]').each((scriptIndex,e)=>{
  const rawJson=$(e).text();if(total+rawJson.length>24000||structuredSources.length>=8)return;
  try{const value:unknown=JSON.parse(rawJson),contentHash=hash(rawJson);structuredSources.push({id:contentHash,sourceUrl:finalUrl,scriptIndex,rawJson,contentHash});total+=rawJson.length;inspect(value,contentHash);}catch{}
 });
 const j=job?.value,a=article?.value;
 const organization=j?.hiringOrganization&&typeof j.hiringOrganization==='object'?j.hiringOrganization as Record<string,unknown>:undefined;
 const organizationName=typeof organization?.name==='string'?organization.name:null;
 const organizationUrl=typeof organization?.sameAs==='string'?organization.sameAs:typeof organization?.url==='string'?organization.url:null;
 let accountHost:string|null=boardHost(publisher)?null:publisher;
 let issuerName:string|null=null,issuerHost:string|null=null,basis:NonNullable<Evidence['attribution']>['basis']='owned_host';
 let sourceRef:NonNullable<Evidence['attribution']>['sourceRef'],linkSource:NonNullable<Evidence['attribution']>['linkSource'];
 if(job&&firstPartyATS(publisher)&&organizationName){
  let url=organizationUrl;
  if(!url){
   const links=$('a[href]').toArray().filter(a=>{const label=$(a).text().trim().toLowerCase();return label.startsWith(organizationName.toLowerCase())&&/home\s?page|website/.test(label);});
   if(links.length===1){const el=links[0];url=new URL($(el).attr('href')!,finalUrl).href;linkSource={html:$.html(el).slice(0,4000),href:url,label:$(el).text().trim()};}
  }
  try{if(url&&!boardHost(hostOf(url))){issuerHost=hostOf(url);issuerName=organizationName;basis='structured_employer';accountHost=issuerHost;
   if(organizationUrl)sourceRef={sourceId:job.sourceId,pointers:[job.pointer+'/hiringOrganization/name',job.pointer+'/hiringOrganization/'+(typeof organization?.sameAs==='string'?'sameAs':'url')]};
  }}catch{}
 }
 const author=a?.author&&typeof a.author==='object'&&!Array.isArray(a.author)?a.author as Record<string,unknown>:null;
 if(article&&author?.['@type']==='Organization'&&typeof author.name==='string'&&typeof (author.url??author.sameAs)==='string'){
  try{issuerHost=hostOf(String(author.url??author.sameAs));issuerName=author.name;basis='structured_issuer';sourceRef={sourceId:article.sourceId,pointers:[article.pointer+'/author/name',article.pointer+'/author/'+(typeof author.url==='string'?'url':'sameAs')]};}catch{}
 }
 if(!issuerHost)$('p,div').each((_i,node)=>{
  const label=$(node).text().replace(/\s+/g,' ').trim();
  if(!/^(?:News provided by|Source:)\s+/i.test(label)||label.length>350)return;
  const links=$(node).find('a[href]').toArray();if(links.length!==1)return;
  const name=$(links[0]).text().trim(),href=$(links[0]).attr('href');if(!name||!href)return;
  try{const url=new URL(href,finalUrl).href,h=hostOf(url);if(h!==publisher){issuerHost=h;issuerName=name;basis='explicit_issuer_link';linkSource={html:$.html(node).slice(0,4000),href:url,label:name};}}catch{}
 });
 // An off-domain issuer is a candidate until company name, host and raw basis are validated together.
 const companyFacts:NonNullable<Evidence['companyFacts']>=[];
 for(const node of organizations){
  const org=node.value;if(typeof org.url!=='string')continue;
  try{const h=hostOf(org.url);if(h!==publisher&&!publisher.endsWith('.'+h))continue;}catch{continue;}
  const add=(field:NonNullable<Evidence['companyFacts']>[number]['field'],value:string|number,paths:string[])=>companyFacts.push({id:randomUUID(),field,value,statement:structuredFactStatement(field,value),sourceRef:{sourceId:node.sourceId,pointers:paths.map(p=>node.pointer+p)}});
  const employee=org.numberOfEmployees,range=employee&&typeof employee==='object'?employee as Record<string,unknown>:null;
  const count=typeof employee==='number'?employee:typeof range?.value==='number'?range.value:null;
  if(count!==null&&Number.isInteger(count)&&count>=0)add('employees',count,[typeof employee==='number'?'/numberOfEmployees':'/numberOfEmployees/value']);
  else if(typeof range?.minValue==='number'&&typeof range?.maxValue==='number'&&Number.isInteger(range.minValue)&&Number.isInteger(range.maxValue)&&range.minValue>=0&&range.maxValue>=range.minValue)add('employeeRange',`${range.minValue}-${range.maxValue}`,['/numberOfEmployees/minValue','/numberOfEmployees/maxValue']);
  const address=org.address&&typeof org.address==='object'?org.address as Record<string,unknown>:null;
  if(typeof address?.addressCountry==='string')add('country',address.addressCountry,['/address/addressCountry']);
  if(typeof org.industry==='string')add('industry',org.industry,['/industry']);
  if(typeof org.name==='string')add('name',org.name,['/name']);
  if(typeof org.alternateName==='string')add('alternateName',org.alternateName,['/alternateName']);
  if(Array.isArray(org.alternateName))org.alternateName.slice(0,3).forEach((v,i)=>{if(typeof v==='string')add('alternateName',v,['/alternateName/'+i]);});
 }
 const published=typeof j?.datePosted==='string'?j.datePosted:typeof a?.datePublished==='string'?a.datePublished:$('meta[property="article:published_time"]').attr('content')??$('time[datetime]').first().attr('datetime')??null;
 const expiry=typeof j?.validThrough==='string'?Date.parse(j.validThrough):NaN;
 $('script,style,noscript,nav,footer,header').remove();
 const root=$('main').length?$('main'):$('body'),text=root.text().replace(/\s+/g,' ').trim().slice(0,18000);
 if(text.length<120)throw new Error('source_text_insufficient');
 return {id:randomUUID(),url:input,finalUrl,title:$('title').text().trim()||(typeof j?.title==='string'?j.title:''),text,contentHash:hash(text),retrievedAt:now.toISOString(),publishedAt:published,source:job?'job_posting_web':'original_web',origin:boardHost(publisher)&&!firstPartyATS(publisher)?'provider_reported':'original',status:Number.isFinite(expiry)&&expiry<now.getTime()?'closed':'unknown',accountHost,structuredSources,companyFacts:companyFacts.slice(0,12),attribution:{publisherHost:publisher,issuerName,issuerHost,basis,sourceType:job?'job':article||issuerHost?'announcement':boardHost(publisher)?'third_party':'company_page',quote:'',sourceRef,linkSource}};
}
