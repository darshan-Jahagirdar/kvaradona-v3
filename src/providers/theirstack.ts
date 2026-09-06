import {z} from 'zod';
import {required} from '../config/env';
import {Candidate} from '../contracts/pipeline';
import {DiscoveryGroup} from '../contracts/discovery';
import {eventKey,hostOf} from '../domain/policy';
import type {OperationGateway} from '../usage/operations';
const nullableText=z.string().nullish();
const Job=z.object({id:z.number().int().positive().safe(),job_title:z.string(),url:z.string(),source_url:z.string(),final_url:nullableText,date_posted:nullableText,discovered_at:nullableText,closed_at:nullableText,description:nullableText,country_codes:z.array(z.string().nullable()).nullish(),company_object:z.object({name:nullableText,domain:nullableText,country_code:nullableText}).nullish()});
const ResponseBody=z.object({data:z.array(Job).max(3),metadata:z.object({truncated_results:z.number().nullable().optional()}).passthrough()});
const Saved=z.object({status:z.number(),body:z.unknown(),observedAt:z.string().datetime()});
export const TheirStackCredits=z.object({api_credits:z.number().int().nonnegative(),used_api_credits:z.number().int().nonnegative(),earliest_expiration:z.string().nullable()});
export function unusedFreeCredits(input:unknown){
 const b=TheirStackCredits.parse(input);
 // Both documented plan types include 200 API credits each cycle. Never use the paid excess.
 return Math.max(0,Math.min(b.api_credits,200-b.used_api_credits));
}
function httpUrl(value:string|null|undefined){try{const u=new URL(value??'');return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password&&(!u.port||['80','443'].includes(u.port))?u.href:null;}catch{return null;}}
function domain(value:string|null|undefined){try{const u=httpUrl('https://'+value);return u&&new URL(u).pathname==='/'&&new URL(u).hostname.includes('.')?hostOf(u):null;}catch{return null;}}
export function theirStackRequest(input:DiscoveryGroup,seenIds:number[],limit=3){
 const g=DiscoveryGroup.parse(input),ids=z.array(z.number().int().positive().safe()).max(500).parse(seenIds);z.number().int().min(1).max(3).parse(limit);
 if(g.source!=='theirstack'||(!g.jobTitlePatterns.length&&!g.jobDescriptionPatterns.length))throw Error('job_search_filter_required');
 return {job_title_pattern_or:g.jobTitlePatterns,job_description_pattern_or:g.jobDescriptionPatterns,job_country_code_or:[g.country],posted_at_max_age_days:g.postedWithinDays,is_closed:false,max_employee_count_or_null:10000,min_employee_count_or_null:1,job_id_not:[...new Set(ids)].sort((a,b)=>a-b),limit,page:0,include_total_results:false,blur_company_data:false};
}
export function normalizeTheirStack(input:unknown,group:DiscoveryGroup,observedAt:string,seenIds:number[]=[]){
 const body=ResponseBody.parse(input),seen=new Set(seenIds),candidates:z.infer<typeof Candidate>[]=[],skipped:{id:number;reason:string}[]=[];
 for(const j of body.data){
  const url=httpUrl(j.final_url)??httpUrl(j.url),sourceUrl=httpUrl(j.source_url);
  if(seen.has(j.id)||!url||!sourceUrl){skipped.push({id:j.id,reason:seen.has(j.id)?'already_observed':'source_url_unavailable'});continue;}
  const description=(j.description??'').slice(0,6000),company=j.company_object?.name??null;
  candidates.push(Candidate.parse({url,title:[company,j.job_title].filter(Boolean).join(' · '),description:description.slice(0,800),source:'theirstack',eventKey:eventKey(url),country:group.country,language:group.language,discoveredAt:observedAt,providerRecord:{provider:'theirstack',id:String(j.id),kind:'provider_reported',sourceUrl,finalUrl:httpUrl(j.final_url),company,companyDomain:domain(j.company_object?.domain),headquartersCountry:j.company_object?.country_code??null,jobCountries:(j.country_codes??[]).filter((v):v is string=>v!==null),postedAt:j.date_posted??null,discoveredAt:j.discovered_at??null,closedAt:j.closed_at??null,description,observedAt}}));
 }
 return {candidates,providerResult:{returnedRecords:body.data.length,chargedCredits:body.data.length,skipped,truncatedResults:body.metadata.truncated_results??null,endpoint:'POST /v1/jobs/search'}};
}
export async function searchTheirStack(operations:OperationGateway,key:string,group:DiscoveryGroup,seenIds:number[],fetcher:typeof fetch=fetch){
 const request=theirStackRequest(group,seenIds);
 const result=await operations.run(key,'theirstack',request,'0',request.limit,Saved,async()=>{
  const r=await fetcher('https://api.theirstack.com/v1/jobs/search',{method:'POST',headers:{Authorization:'Bearer '+required('THEIRSTACK_API_KEY'),'Content-Type':'application/json'},body:JSON.stringify(request),redirect:'error',signal:AbortSignal.timeout(20000)});
  const bytes:Uint8Array[]=[];let size=0;const reader=r.body?.getReader();if(!reader)throw Error('provider_body_missing');
  try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>1000000)throw Error('provider_response_limit');bytes.push(chunk.value);}}finally{await reader.cancel().catch(()=>{});}
  const body:unknown=JSON.parse(Buffer.concat(bytes).toString('utf8')),parsed=ResponseBody.safeParse(body);
  return {response:{status:r.status,body,observedAt:new Date().toISOString()},usage:{http_status:r.status,request_id:r.headers.get('x-request-id'),reserved_credits:request.limit,actual_credits:r.ok&&parsed.success?parsed.data.data.length:null,rate_limit:r.headers.get('ratelimit-policy'),pricing_version:'theirstack-jobs-2026-09-06'},actual:'0'};
 });
 if(result.status!==200)throw Error(`theirstack_http_${result.status}`);
 return normalizeTheirStack(result.body,group,result.observedAt,seenIds);
}
