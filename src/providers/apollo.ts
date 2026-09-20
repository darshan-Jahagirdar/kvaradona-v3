import {z} from 'zod';
import {intentIcp} from '../domain/intent-icp';
import {evidencedCompanyNames} from '../domain/evidence-attribution';
import type {Packet} from '../contracts/pipeline';
import type {Contact} from '../contracts/pipeline';
import type {SavedOperation} from '../domain/provider-evidence';
import {contactPending,hostOf,isFresh,hash} from '../domain/policy';
import {required} from '../config/env';
import type {OperationGateway} from '../usage/operations';
const Envelope=z.object({httpStatus:z.number().int(),body:z.unknown()});
const Search=z.object({total_entries:z.number().optional(),people:z.array(z.object({id:z.string(),first_name:z.string().nullable().optional(),last_name_obfuscated:z.string().nullable().optional(),title:z.string().nullable(),last_refreshed_at:z.string().nullable().optional(),has_email:z.boolean().optional(),organization:z.object({name:z.string()}).nullable()}))});
const Person=z.object({id:z.string(),name:z.string().nullable().optional(),title:z.string().nullable(),email:z.string().nullable().optional(),email_status:z.string().nullable().optional(),last_refreshed_at:z.string().nullable().optional(),organization_id:z.string().nullable().optional(),organization:z.object({id:z.string().optional(),name:z.string(),primary_domain:z.string().nullable().optional(),website_url:z.string().nullable().optional()}).nullable(),employment_history:z.array(z.object({current:z.boolean().optional(),organization_id:z.string().nullable().optional(),end_date:z.string().nullable().optional(),title:z.string().nullable().optional()})).optional()});
const normalize=(v:string)=>v.toLowerCase().replace(/[^a-z0-9]/g,'');
export function contactTitles(role:string){
 const titles:string[]=[];
 if(/revenue|revops|crm|sales operations|business systems/i.test(role))titles.push('revenue operations','sales operations','business systems','CRM');
 if(/marketing[^.;]{0,35}operations|campaign operations|lifecycle|automation/i.test(role))titles.push('marketing operations','marketing automation');
 if(/marketing|growth|conversion|seo|aeo|digital|corporate web|website|web experience/i.test(role)&&!titles.length)titles.push('marketing','growth','digital');
 // The named role leads the sentence. A generic keyword further along ("the digital owner of a unit")
 // must not erase it, or every account searches the same three titles and the evidenced owner is missed.
 const lead=role.split(/[,;]|\bor\b/i)[0].trim().replace(/\s+/g,' ');
 if(lead&&lead.length<=120&&/\s/.test(lead)&&!/unknown/i.test(lead)&&!titles.some(t=>normalize(lead)===normalize(t)))titles.unshift(lead);
 return titles.length?titles:[role.slice(0,120)];
}
const expandRole=(value:string)=>value.replace(/\bCMO\b/gi,'Chief Marketing Officer').replace(/\bCEO\b/gi,'Chief Executive Officer').replace(/\bSVP\b/gi,'Senior Vice President').replace(/\bEVP\b/gi,'Executive Vice President').replace(/\bVP\b/gi,'Vice President');
export function roleScore(title:string,role:string){
 const expanded=expandRole(title).replace(/[,/&-]+/g,' ').replace(/\s+/g,' ');
 const matches=contactTitles(expandRole(role)).some(t=>expanded.toLowerCase().includes(t.toLowerCase()));
 return matches?10+(/\b(head|director|vice president|chief|manager|lead)\b/i.test(expanded)?10:0):0;
}
/** "Boston Medical Center (BMC)" is the same entity as "Boston Medical Center": the parenthetical is
 *  that name's own initials. A parenthetical that is NOT the initials names a different entity
 *  ("Boston Medical Center (Brighton)"), so it is left unmatched rather than admitted as an affiliate. */
function withoutOwnAcronym(name:string){
 const m=/^(.+?)\s*\(([A-Za-z][A-Za-z.&\s]{0,14})\)\s*$/.exec(name.trim());if(!m)return null;
 const initials=m[1].split(/\s+/).filter(w=>/^[A-Za-z]/.test(w)).map(w=>w[0]).join('');
 return initials.length>=2&&normalize(m[2])===normalize(initials)?m[1].trim():null;
}
export function companyMatches(name:string,company:string,packet?:Packet){
 const forms=(v:string)=>{const base=withoutOwnAcronym(v);return base?[v,base]:[v];};
 const observed=forms(name);
 return [company,...packet?evidencedCompanyNames(packet):[]].some(n=>forms(n).some(a=>observed.some(b=>normalize(a)===normalize(b))));
}
function httpReason(status:number){return status===401?'Apollo rejected the API key.':status===403?'Apollo denied this endpoint; key scope or account entitlement needs attention.':status===429?'Apollo rate limit reached; no immediate retry.':`Apollo returned HTTP ${status}; contact availability remains unknown.`;}
export function intentBuyerTitle(title:string){const t=expandRole(title).replace(/[,/&]+/g,' ');return /\b(chief marketing(?: and communications)? officer|chief executive officer|operations|sales manager|sales head|head of sales|vice president(?: of)? marketing|vice president(?: of)? sales)\b/i.test(t.replace(/\s+/g,' '));}
function buyerSearchTitles(role:string,intentOnly:boolean){
 if(!intentOnly)return contactTitles(role);
 if(contactTitles(role).some(t=>t.includes('marketing')))return ['marketing','digital','growth'];
 return [...intentIcp.buyerTitles,'Chief Marketing Officer','Chief Executive Officer','Vice President Marketing','Vice President Sales','Head of Sales'];
}
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
export function enrichmentParams(host:string,personId:string){return {id:personId,domain:host,reveal_personal_emails:'false',reveal_phone_number:'false',run_waterfall_email:'false',run_waterfall_phone:'false'};}
export class ApolloContacts {
 constructor(private operations:ContactOperations,private allowance:FreeContactAllowance|null,private request:typeof fetch=fetch,private savedSearch?:unknown,private history:{operations:SavedOperation[]}={operations:[]}){}
 private call(key:string,path:string,params:Record<string,string|string[]>,units:number){return callApollo(this.operations,this.request,key,path,params,units);}

 async resolve(host:string,role:string,company:string,intentIcpOnly=false,packet?:Packet):Promise<Contact>{
  if(!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host))throw new Error('invalid_account_domain');
  const pending=(reason:string,candidates:Contact['candidates']=[]):Contact=>({...contactPending(role,reason),source:'apollo',candidates});
  const refresh=packet?.contactSearchRequest&&!packet.contactSearchRequest.completedAt?packet.contactSearchRequest:null;
  if(refresh&&refresh.reason.trim().length<20)return pending('A specific reason for refreshing saved buyer criteria or stale/exhausted candidates is required.');
  const searchKey=refresh?'contact_search_refresh_'+refresh.requestId:'contact_search';
  const priorRefresh=refresh?this.history.operations.find(o=>o.operation_key?.endsWith(':'+searchKey)):null;
  if(priorRefresh&&(priorRefresh.state!=='succeeded'||priorRefresh.actual_usd===null))return pending('The requested contact search has an unresolved operation; no automatic redispatch.');
  const saved=Envelope.safeParse(refresh?priorRefresh?.response:this.savedSearch),savedPeople=saved.success&&saved.data.httpStatus===200?Search.safeParse(saved.data.body):null;
  const reusable=savedPeople?.success;
  let response;
  try{response=reusable&&saved.success?saved.data:await this.call(searchKey,'mixed_people/api_search',{'q_organization_domains_list[]':[host],'person_titles[]':buyerSearchTitles(role,intentIcpOnly),include_similar_titles:'true',page:'1',per_page:'25'},0);}
  catch(e){if(e instanceof Error&&/^(provider_unverified|live_disabled|budget_paused)$/.test(e.message))return pending('Apollo search is not enabled within the current verified limits.');throw e;}
  if(refresh&&packet?.contactSearchRequest)packet.contactSearchRequest.completedAt=new Date().toISOString();
  if(response.httpStatus!==200)return pending(httpReason(response.httpStatus));
  const parsed=Search.safeParse(response.body);if(!parsed.success)return pending('Apollo search returned an unrecognized response; no contact assumed.');
  const candidates=parsed.data.people.filter(p=>p.organization&&companyMatches(p.organization.name,company,packet)&&roleScore(p.title??'',role)>0&&(!intentIcpOnly||intentBuyerTitle(p.title??''))).sort((a,b)=>roleScore(b.title??'',role)-roleScore(a.title??'',role)||Number(b.has_email&&isFresh(b.last_refreshed_at??null,90))-Number(a.has_email&&isFresh(a.last_refreshed_at??null,90))).slice(0,5).map(p=>({providerId:p.id,displayName:[p.first_name,p.last_name_obfuscated].filter(Boolean).join(' ')||'Name withheld',role:p.title??role,company:p.organization!.name,refreshedAt:p.last_refreshed_at??null,emailAvailable:p.has_email===true,reason:'Provider-reported role/company match. Partial name and email availability do not establish an address or verified current employment.'}));
  if(!candidates.length)return pending(parsed.data.people.length?'Search results did not establish a matching current company and relevant role.':'No matching people returned in this bounded search; company potential remains unchanged.');
  if(refresh)return pending('Requested fresh buyer search completed; candidates preserved. Resume contact resolution separately to check employment and verified work email.',candidates);
  const selected=candidates.find(c=>c.emailAvailable&&roleScore(c.role,role)>=20&&isFresh(c.refreshedAt,90));
  if(!selected)return pending('Candidates need a current relevant buyer role and sufficiently recent provider data before email enrichment.',candidates);
  const params=enrichmentParams(host,selected.providerId),requestHash=hash({endpoint:'people/match',params});
  const priorReveal=this.history.operations.find(o=>o.request_hash===requestHash&&o.provider==='apollo');
  if(priorReveal&&(priorReveal.state!=='succeeded'||priorReveal.actual_usd===null))return pending('An earlier reveal for this person is unresolved; no repeat reveal.',candidates);
  let enriched;
  if(priorReveal){
   if(!isFresh(priorReveal.created_at,90))return pending('The saved reveal is stale; verify current employment through a separately authorized refresh. No automatic repeat reveal.',candidates);
   const parsed=Envelope.safeParse(priorReveal.response);if(!parsed.success)return pending('Saved reveal requires review; no repeat reveal.',candidates);enriched=parsed.data;
  }else{
   if(!this.allowance?.verifiedFree||this.allowance.remaining<1||Date.parse(this.allowance.expiresAt)<=Date.now()||!Number.isFinite(Date.parse(this.allowance.expiresAt))||this.allowance.evidence.trim().length<20)return pending('Relevant buyer candidate found. Email enrichment awaits a verified free credit allowance; no reveal attempted.',candidates);
   try{enriched=await this.call('contact_enrichment','people/match',params,1);}
   catch(e){if(e instanceof Error&&/^(free_quota_unverified_or_exhausted|provider_unverified|live_disabled|budget_paused)$/.test(e.message))return pending('The free enrichment allowance is unavailable or exhausted; candidate preserved.',candidates);throw e;}
  }
  if(enriched.httpStatus!==200)return pending(httpReason(enriched.httpStatus),candidates);
  const result=z.object({person:Person.nullable()}).safeParse(enriched.body);if(!result.success||!result.data.person)return pending('Apollo did not return a usable matched person.',candidates);
  const person=result.data.person;let employerHost:string|null=null;
  try{employerHost=person.organization?.primary_domain?hostOf('https://'+person.organization.primary_domain):person.organization?.website_url?hostOf(person.organization.website_url):null;}catch{}
  const current=person.employment_history?.some(e=>e.current===true&&!e.end_date&&e.organization_id===person.organization?.id&&Boolean(e.organization_id));
  const verified=person.id===selected.providerId&&employerHost===host&&companyMatches(person.organization?.name??'',company,packet)&&current&&roleScore(person.title??'',role)>=20&&(!intentIcpOnly||intentBuyerTitle(person.title??''));
  const email=z.string().email().safeParse(person.email);
  const emailStatus=person.email_status==='verified'?'provider_verified':/catch.?all/i.test(person.email_status??'')?'catch_all':person.email_status==='invalid'?'invalid':'unknown';
  if(!verified||!person.name||!email.success||email.data.split('@')[1].toLowerCase()!==host||emailStatus!=='provider_verified')return {...pending('Enrichment did not confirm the exact person, current employer, relevant role and verified work-domain email. No sendable recipient selected.',candidates),emailStatus};
  return {name:person.name,role:person.title!,email:email.data,emailStatus,employmentEvidence:`Apollo person ${person.id}: current employment at ${person.organization!.name} (${host}); provider reported, checked ${new Date().toISOString()}.`,source:'apollo',observedAt:priorReveal?new Date(priorReveal.created_at).toISOString():new Date().toISOString(),state:'resolved',reason:'Apollo reports a verified work email and matching current employment. This is provider evidence; relationship and sending approval checks still apply.',candidates};
 }
}
