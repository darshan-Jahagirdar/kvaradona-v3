import {z} from 'zod';
import {intentIcp} from '../domain/intent-icp';
import type {Contact} from '../contracts/pipeline';
import {contactPending,hostOf,isFresh} from '../domain/policy';
import {required} from '../config/env';
import type {OperationGateway} from '../usage/operations';
const Envelope=z.object({httpStatus:z.number().int(),body:z.unknown()});
const Search=z.object({total_entries:z.number().optional(),people:z.array(z.object({id:z.string(),first_name:z.string().nullable().optional(),last_name_obfuscated:z.string().nullable().optional(),title:z.string().nullable(),last_refreshed_at:z.string().nullable().optional(),has_email:z.boolean().optional(),organization:z.object({name:z.string()}).nullable()}))});
const Person=z.object({id:z.string(),name:z.string().nullable().optional(),title:z.string().nullable(),email:z.string().nullable().optional(),email_status:z.string().nullable().optional(),last_refreshed_at:z.string().nullable().optional(),organization_id:z.string().nullable().optional(),organization:z.object({id:z.string().optional(),name:z.string(),primary_domain:z.string().nullable().optional(),website_url:z.string().nullable().optional()}).nullable(),employment_history:z.array(z.object({current:z.boolean().optional(),organization_id:z.string().nullable().optional(),end_date:z.string().nullable().optional(),title:z.string().nullable().optional()})).optional()});
const normalize=(v:string)=>v.toLowerCase().replace(/[^a-z0-9]/g,'');
export function contactTitles(role:string){
 if(/revenue|revops|crm|sales operations|business systems/i.test(role))return ['revenue operations','sales operations','business systems','CRM'];
 if(/marketing|growth|conversion|seo|aeo/i.test(role))return ['marketing','growth','digital'];
 return [role.slice(0,120)];
}
function roleScore(title:string,role:string){const matches=contactTitles(role).some(t=>title.toLowerCase().includes(t.toLowerCase()));return matches?10+(/head|director|vp\b|vice president|chief|manager|lead/i.test(title)?10:0):0;}
function httpReason(status:number){return status===401?'Apollo rejected the API key.':status===403?'Apollo denied this endpoint; key scope or account entitlement needs attention.':status===429?'Apollo rate limit reached; no immediate retry.':`Apollo returned HTTP ${status}; contact availability remains unknown.`;}
export function intentBuyerTitle(title:string){return /\b(cmo|chief marketing officer|ceo|chief executive officer|operations|sales manager|sales head|head of sales|vp(?: of)? marketing|vice president(?: of)? marketing|vp(?: of)? sales|vice president(?: of)? sales)\b/i.test(title);}
export interface FreeContactAllowance {remaining:number;expiresAt:string;evidence:string;verifiedFree:boolean;}
export type ContactOperations=Pick<OperationGateway,'run'>;
export async function callApollo(operations:ContactOperations,request:typeof fetch,key:string,path:string,params:Record<string,string|string[]>,units:number){
  const url=new URL('https://api.apollo.io/api/v1/'+path);for(const [name,value]of Object.entries(params))for(const v of Array.isArray(value)?value:[value])url.searchParams.append(name,v);
  return operations.run(key,'apollo',{endpoint:path,params},'0',units,Envelope,async()=>{
   const r=await request(url,{method:'POST',headers:{'x-api-key':required('APOLLO_API_KEY'),'Content-Type':'application/json',accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});
   const reader=r.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
   if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1000000){await reader.cancel();throw new Error('apollo_response_limit');}chunks.push(value);}
   let body:unknown;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{body={invalidJson:true};}
   return {response:{httpStatus:r.status,body},usage:{endpoint:path,http_status:r.status,request_id:r.headers.get('x-request-id'),reserved_credits:units,credit_basis:units?'verified_free_allowance':'documented_zero_credit_endpoint',pricing_source:'https://docs.apollo.io/docs/api-pricing'},actual:'0'};
  });
 }
export class ApolloContacts {
 constructor(private operations:ContactOperations,private allowance:FreeContactAllowance|null,private request:typeof fetch=fetch){}
 private call(key:string,path:string,params:Record<string,string|string[]>,units:number){return callApollo(this.operations,this.request,key,path,params,units);}

 async resolve(host:string,role:string,company:string,intentIcpOnly=false):Promise<Contact>{
  if(!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host))throw new Error('invalid_account_domain');
  const pending=(reason:string,candidates:Contact['candidates']=[]):Contact=>({...contactPending(role,reason),source:'apollo',candidates});
  let response;
  try{response=await this.call('contact_search','mixed_people/api_search',{'q_organization_domains_list[]':[host],'person_titles[]':intentIcpOnly?[...intentIcp.buyerTitles,'Chief Marketing Officer','Chief Executive Officer','Vice President Marketing','Vice President Sales','Head of Sales']:contactTitles(role),include_similar_titles:'false',page:'1',per_page:'5'},0);}
  catch(e){if(e instanceof Error&&/^(provider_unverified|live_disabled|budget_paused)$/.test(e.message))return pending('Apollo search is not enabled within the current verified limits.');throw e;}
  if(response.httpStatus!==200)return pending(httpReason(response.httpStatus));
  const parsed=Search.safeParse(response.body);if(!parsed.success)return pending('Apollo search returned an unrecognized response; no contact assumed.');
  const candidates=parsed.data.people.filter(p=>p.organization&&normalize(p.organization.name)===normalize(company)&&roleScore(p.title??'',role)>0&&(!intentIcpOnly||intentBuyerTitle(p.title??''))).sort((a,b)=>roleScore(b.title??'',role)-roleScore(a.title??'',role)).slice(0,5).map(p=>({providerId:p.id,displayName:[p.first_name,p.last_name_obfuscated].filter(Boolean).join(' ')||'Name withheld',role:p.title??role,company:p.organization!.name,refreshedAt:p.last_refreshed_at??null,emailAvailable:p.has_email===true,reason:'Provider-reported role/company match. Partial name and email availability do not establish an address or verified current employment.'}));
  if(!candidates.length)return pending(parsed.data.people.length?'Search results did not establish a matching current company and relevant role.':'No matching people returned in this bounded search; company potential remains unchanged.');
  const selected=candidates.find(c=>c.emailAvailable&&roleScore(c.role,role)>=20&&isFresh(c.refreshedAt,90));
  if(!selected)return pending('Candidates need a current relevant buyer role and sufficiently recent provider data before email enrichment.',candidates);
  if(!this.allowance?.verifiedFree||this.allowance.remaining<1||Date.parse(this.allowance.expiresAt)<=Date.now()||!Number.isFinite(Date.parse(this.allowance.expiresAt))||this.allowance.evidence.trim().length<20)return pending('Relevant buyer candidate found. Email enrichment awaits a verified free credit allowance; no reveal attempted.',candidates);
  let enriched;
  try{enriched=await this.call('contact_enrichment','people/match',{id:selected.providerId,domain:host,reveal_personal_emails:'false',reveal_phone_number:'false',run_waterfall_email:'false',run_waterfall_phone:'false'},1);}
  catch(e){if(e instanceof Error&&/^(free_quota_unverified_or_exhausted|provider_unverified|live_disabled|budget_paused)$/.test(e.message))return pending('The free enrichment allowance is unavailable or exhausted; candidate preserved.',candidates);throw e;}
  if(enriched.httpStatus!==200)return pending(httpReason(enriched.httpStatus),candidates);
  const result=z.object({person:Person.nullable()}).safeParse(enriched.body);if(!result.success||!result.data.person)return pending('Apollo did not return a usable matched person.',candidates);
  const person=result.data.person;let employerHost:string|null=null;
  try{employerHost=person.organization?.primary_domain?hostOf('https://'+person.organization.primary_domain):person.organization?.website_url?hostOf(person.organization.website_url):null;}catch{}
  const current=person.employment_history?.some(e=>e.current===true&&!e.end_date&&e.organization_id===person.organization?.id&&Boolean(e.organization_id));
  const verified=person.id===selected.providerId&&employerHost===host&&normalize(person.organization?.name??'')===normalize(company)&&current&&roleScore(person.title??'',role)>=20&&(!intentIcpOnly||intentBuyerTitle(person.title??''));
  const email=z.string().email().safeParse(person.email);
  const emailStatus=person.email_status==='verified'?'provider_verified':/catch.?all/i.test(person.email_status??'')?'catch_all':person.email_status==='invalid'?'invalid':'unknown';
  if(!verified||!person.name||!email.success||email.data.split('@')[1].toLowerCase()!==host||emailStatus!=='provider_verified')return {...pending('Enrichment did not confirm the exact person, current employer, relevant role and verified work-domain email. No sendable recipient selected.',candidates),emailStatus};
  return {name:person.name,role:person.title!,email:email.data,emailStatus,employmentEvidence:`Apollo person ${person.id}: current employment at ${person.organization!.name} (${host}); provider reported, checked ${new Date().toISOString()}.`,source:'apollo',observedAt:new Date().toISOString(),state:'resolved',reason:'Apollo reports a verified work email and matching current employment. This is provider evidence; relationship and sending approval checks still apply.',candidates};
 }
}
