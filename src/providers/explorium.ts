import {z} from 'zod';
import {required} from '../config/env';
import {Candidate} from '../contracts/pipeline';
import {ProviderCompany,type DiscoveryGroup} from '../contracts/discovery';
import {hash,hostOf} from '../domain/policy';
import {exploriumFilters,exploriumIcp,exploriumPilotTopic,exploriumPageSize,discoveryExcludedDomains} from '../domain/explorium-icp';
import type {ContactOperations} from './apollo';
const Envelope=z.object({httpStatus:z.number().int(),body:z.unknown()});
const Row=z.object({business_id:z.string().regex(/^[a-f0-9]{32}$/),name:z.string().min(1),domain:z.string(),country_name:z.string().nullable().optional(),number_of_employees_range:z.string().nullable().optional(),naics_description:z.string().nullable().optional(),business_description:z.string().nullable().optional(),business_intent_topics:z.array(z.object({topic:z.string(),score:z.number()})).optional()});
export async function callExplorium(operations:ContactOperations,key:string,path:string,body:unknown,maxCredits:number,request:typeof fetch=fetch){
 const result=await operations.run(key,'explorium',{path,body},'0',maxCredits,Envelope,async()=>{
  const r=await request('https://api.explorium.ai/v2/'+path,{method:'POST',headers:{api_key:required('EXPLORIUM_API_KEY'),'Content-Type':'application/json',accept:'application/json','credit-usage':'true'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(45000)});
  const reader=r.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
  if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1000000){await reader.cancel();throw Error('explorium_response_limit');}chunks.push(value);}
  let data:unknown;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{data={invalidJson:true};}
  const usage=z.object({credit_usage:z.object({total_credits:z.number().int().nonnegative()})}).safeParse(data);
  return {response:{httpStatus:r.status,body:data},usage:{endpoint:path,http_status:r.status,actualCredits:usage.success?usage.data.credit_usage.total_credits:null,reservedCredits:maxCredits,creditBasis:'verified_trial_only',pricingSource:'https://www.explorium.ai/credit-details/'},actual:'0'};
 });
 if(result.httpStatus!==200)throw Error(result.httpStatus===403?'explorium_intent_access_denied':`explorium_http_${result.httpStatus}`);
 const usage=z.object({credit_usage:z.object({total_credits:z.number().int().nonnegative()})}).safeParse(result.body);
 if(!usage.success)throw Error('explorium_credit_usage_unknown');
 if(usage.data.credit_usage.total_credits>maxCredits)throw Error('explorium_credit_reservation_exceeded');
 return result.body;
}
export function exploriumCandidates(body:unknown,observedAt=new Date().toISOString()){
 const response=z.object({data:z.array(z.unknown()).max(exploriumPageSize),page:z.object({next_cursor:z.string().nullable().optional()}).optional()}).parse(body);
 const candidates:z.infer<typeof Candidate>[]=[];let invalid=0,excluded=0;
 for(const raw of response.data){
  const parsed=Row.safeParse(raw);if(!parsed.success){invalid++;continue;}const r=parsed.data;
  let domain:string;try{domain=hostOf('https://'+r.domain);if(!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)||r.domain.includes('/')||r.domain.includes('@'))throw Error();}catch{invalid++;continue;}
  if(discoveryExcludedDomains.some(d=>domain===d||domain.endsWith('.'+d))){excluded++;continue;}
  const signals=(r.business_intent_topics??[]).filter(s=>s.topic===exploriumPilotTopic&&s.score>60&&s.score<=100);
  if(!signals.length){invalid++;continue;}
  const icp=exploriumIcp(r),sourceUrl='https://api.explorium.ai/v2/businesses';
  const company=ProviderCompany.parse({provider:'explorium',id:r.business_id,kind:'provider_reported',name:r.name,domain,headquartersCountry:r.country_name??null,employees:null,employeeRange:r.number_of_employees_range??null,industry:r.naics_description??null,observedAt,sourceUrl,provenance:{name:'name',domain:'domain',headquartersCountry:'country_name',employees:'number_of_employees_range',industry:'naics_description'},icp,intent:{status:'unknown',reason:'Explorium/Bombora reports the requested topic and score; dated corroboration is required before automatic research.',topics:signals.map(s=>({topic:s.topic,score:s.score,sourceDate:null}))}});
  candidates.push(Candidate.parse({url:'https://'+domain,title:r.name,description:(r.business_description??'Explorium company with provider-reported intent.').slice(0,600),source:'explorium',eventKey:hash(['explorium_company',r.business_id]),country:icp.searchCountry==='unknown'?'US':icp.searchCountry,language:'en',discoveredAt:observedAt,providerCompany:company}));
 }
 if(response.data.length&&!candidates.length&&invalid)throw Error('explorium_intent_results_invalid');
 return {candidates,providerResult:{returned:response.data.length,invalid,excluded,nextCursor:response.page?.next_cursor??null,topic:exploriumPilotTopic}};
}
export function applyExploriumIntent(c:z.infer<typeof Candidate>,body:unknown,now=new Date()){
 const result=z.object({data:z.array(z.object({business_id:z.string(),data:z.object({business_id:z.string(),company_website:z.string(),date_stamp:z.string(),intent_topics:z.string()}).nullable()}))}).safeParse(body);
 const row=result.success?result.data.data.find(r=>r.business_id===c.providerCompany?.id)?.data:null;
 const pending=(reason:string)=>{c.providerCompany!.intent.reason=reason;return c;};
 if(!row||row.business_id!==c.providerCompany!.id)return pending('Dated intent details unavailable; retain for human review.');
 if(row.company_website.toLowerCase().replace(/^www\./,'')!==c.providerCompany!.domain)return pending('Intent response company identity does not match.');
 if(!/^\d{8}$/.test(row.date_stamp))return pending('Intent observation date is invalid.');
 const date=row.date_stamp.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3'),time=Date.parse(date+'T00:00:00Z');
 if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==date||time>now.getTime()+86400000||time<now.getTime()-14*86400000)return pending('Intent observation is stale or invalid.');
 let topics:unknown;try{topics=JSON.parse(row.intent_topics);}catch{return pending('Intent topic details could not be validated.');}
 const parsed=z.array(z.object({topic:z.string(),composite_score:z.number().min(0).max(100)})).safeParse(topics);
 const matching=parsed.success?parsed.data.filter(t=>t.topic===exploriumPilotTopic&&t.composite_score>60):[];
 if(!matching.length)return pending('Dated enrichment did not corroborate the requested intent topic.');
 c.providerCompany!.intent={status:'provider_reported',reason:'Explorium/Bombora reports recent topic research, not a confirmed purchase or project.',topics:matching.map(t=>({topic:t.topic,score:t.composite_score,sourceDate:date}))};return c;
}
export async function searchExploriumCompanies(operations:ContactOperations,key:string,group:DiscoveryGroup,request:typeof fetch=fetch){
 const body={mode:'full',page_size:exploriumPageSize,filters:exploriumFilters(),...(group.nextCursor?{next_cursor:group.nextCursor}:{})};
 // The measured intent-filtered request charged 2 credits/company. Reserve exactly that for the requested page.
 const result=exploriumCandidates(await callExplorium(operations,key,'businesses',body,2*exploriumPageSize,request));let enriched=0;
 for(const c of result.candidates){
  if(c.providerCompany!.icp.status!=='match'||enriched>=exploriumPageSize)continue;
  const detail=await callExplorium(operations,`${key}:intent:${c.providerCompany!.id}`,'businesses/bombora_intent/enrich',{business_ids:[c.providerCompany!.id],parameters:{topics:[exploriumPilotTopic],min_score:61}},2,request);
  applyExploriumIntent(c,detail);enriched++;
 }
 return {...result,providerResult:{...result.providerResult,filters:body.filters,enriched,httpStatus:200}};
}
