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

/** The bounded search plan for one company and service: the roles A2 asked for, then at most two
 *  MEANINGFULLY different alternatives. Each alternative must add titles the earlier attempts did
 *  not already search, so a resume never re-buys the same question. */
export function contactSearchPlan(role:string,service:string){
 const base=contactTitles(role);
 const text=`${role} ${service}`.toLowerCase();
 const web=/website|web |cro|conversion|journey|seo|aeo|search|content|digital experience/.test(text);
 const alternatives:{titles:string[];reason:string}[]=[];
 // 1. The people who own the work itself, rather than the function that sponsors it.
 alternatives.push(web
  ?{titles:['web','website','demand generation','lifecycle','content','product marketing'],
    reason:'The first search covered the sponsoring function. This one looks for the people who own the web and demand surfaces the offer is about.'}
  :{titles:['revenue operations','marketing operations','business systems','demand generation'],
    reason:'The first search covered the sponsoring function. This one looks for the operations owners of the proposed work.'});
 // 2. A named accountable owner, for a small company where the function may not be staffed.
 alternatives.push({titles:['head of marketing','marketing director','chief marketing officer','founder','managing director','chief executive officer'],
  reason:'No reachable owner of the function was found, so this looks for the named senior owner a smaller company would route this to.'});
 const seen=new Set(base.map(t=>t.toLowerCase()));
 const plan=[{titles:base,reason:'Roles derived from the campaign and the researched service.'}];
 for(const alt of alternatives){
  const fresh=alt.titles.filter(t=>!seen.has(t.toLowerCase()));
  if(!fresh.length)continue;
  for(const t of fresh)seen.add(t.toLowerCase());
  plan.push({titles:fresh,reason:alt.reason});
 }
 return plan.slice(0,3);
}

/** Why this person cannot be used, stated per requirement rather than as one opaque refusal. */
export function candidateLimitations(p:{title:string|null;has_email?:boolean;last_refreshed_at?:string|null;organization:{name:string}|null},
 role:string,company:string,packet?:Packet){
 const limitations:string[]=[];
 if(!p.organization||!companyMatches(p.organization.name,company,packet))limitations.push('employer_unconfirmed');
 const score=roleScore(p.title??'',role);
 if(score<=0)limitations.push('role_not_relevant');
 else if(score<20)limitations.push('below_buyer_seniority');
 if(!isFresh(p.last_refreshed_at??null,90))limitations.push('provider_data_stale');
 if(p.has_email!==true)limitations.push('no_provider_email');
 return limitations as ('employer_unconfirmed'|'role_not_relevant'|'below_buyer_seniority'|'provider_data_stale'|'no_provider_email')[];
}

const limitationText:Record<string,string>={
 employer_unconfirmed:'the provider does not place them at this company',
 role_not_relevant:'their title does not match the researched service',
 below_buyer_seniority:'their title is relevant but below the buyer seniority this offer needs',
 provider_data_stale:'the provider record is older than 90 days',
 no_provider_email:'the provider reports no work email for them',
};
/** One sentence naming exactly which requirement each preserved candidate fails. */
export function candidateBlockSummary(candidates:{displayName:string;role:string;limitations?:readonly string[]}[]){
 return candidates.map(c=>`${c.displayName} (${c.role}): ${(c.limitations??[]).map(l=>limitationText[l]??l).join('; ')||'no recorded limitation'}`).join(' · ');
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

 async resolve(host:string,role:string,company:string,intentIcpOnly=false,packet?:Packet,service=''):Promise<Contact>{
  if(!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host))throw new Error('invalid_account_domain');
  const pending=(reason:string,candidates:Contact['candidates']=[]):Contact=>({...contactPending(role,reason),source:'apollo',candidates});
  const refresh=packet?.contactSearchRequest&&!packet.contactSearchRequest.completedAt?packet.contactSearchRequest:null;
  if(refresh&&refresh.reason.trim().length<20)return pending('A specific reason for refreshing saved buyer criteria or stale/exhausted candidates is required.');
  const searchKey=refresh?'contact_search_refresh_'+refresh.requestId:'contact_search';
  const priorRefresh=refresh?this.history.operations.find(o=>o.operation_key?.endsWith(':'+searchKey)):null;
  if(priorRefresh&&(priorRefresh.state!=='succeeded'||priorRefresh.actual_usd===null))return pending('The requested contact search has an unresolved operation; no automatic redispatch.');
  const saved=Envelope.safeParse(refresh?priorRefresh?.response:this.savedSearch),savedPeople=saved.success&&saved.data.httpStatus===200?Search.safeParse(saved.data.body):null;
  const reusable=savedPeople?.success;
  // The plan is persisted, so a resume reuses settled searches instead of re-buying them.
  const plan=refresh?[{titles:buyerSearchTitles(role,intentIcpOnly),reason:'Requested fresh buyer search.'}]
   :contactSearchPlan(role,service);
  if(packet&&!packet.contactPlan)packet.contactPlan={attempts:[]};
  const record=(key:string,titles:string[],reason:string,returned:number,outcome:'no_results'|'no_relevant_candidate'|'no_reachable_candidate'|'resolved'|'blocked')=>{
   if(!packet?.contactPlan)return;
   packet.contactPlan.attempts=[...packet.contactPlan.attempts.filter(a=>a.key!==key),
    {key,titles:titles.slice(0,8),reason,at:new Date().toISOString(),returned,outcome}].slice(-3);
  };

  let candidates:NonNullable<Contact['candidates']>=[],anyPeople=false,lastKey=searchKey;
  for(const [index,step] of plan.entries()){
   // Stable, distinct keys: the same question always reuses its settled operation, and a genuinely
   // different question is a separate operation rather than a silent repeat.
   const key=refresh?searchKey:index===0?'contact_search':`contact_search_alt_${index}`;
   lastKey=key;
   const priorAttempt=this.history.operations.find(o=>o.operation_key?.endsWith(':'+key));
   if(priorAttempt&&(priorAttempt.state!=='succeeded'||priorAttempt.actual_usd===null))
    return pending('An earlier contact search for this company has an unresolved operation; no automatic redispatch.',candidates);
   const savedForKey=index===0&&!refresh?saved:Envelope.safeParse(priorAttempt?.response);
   const reusableForKey=savedForKey.success&&savedForKey.data.httpStatus===200&&Search.safeParse(savedForKey.data.body).success;
   let response;
   try{response=reusableForKey&&savedForKey.success?savedForKey.data
    :await this.call(key,'mixed_people/api_search',{'q_organization_domains_list[]':[host],'person_titles[]':step.titles,include_similar_titles:'true',page:'1',per_page:'25'},0);}
   catch(e){if(e instanceof Error&&/^(provider_unverified|live_disabled|budget_paused)$/.test(e.message)){
    record(key,step.titles,step.reason,0,'blocked');
    return pending('Apollo search is not enabled within the current verified limits.',candidates);}throw e;}
   if(response.httpStatus!==200){record(key,step.titles,step.reason,0,'blocked');return pending(httpReason(response.httpStatus),candidates);}
   const parsedStep=Search.safeParse(response.body);
   if(!parsedStep.success){record(key,step.titles,step.reason,0,'blocked');return pending('Apollo search returned an unrecognized response; no contact assumed.',candidates);}
   anyPeople=anyPeople||parsedStep.data.people.length>0;
   // Everyone the provider actually places at this company is kept, with their limitations named.
   // A junior or email-less person stays visible; they are never promoted to a resolved contact.
   const found=parsedStep.data.people
    .filter(p=>p.organization&&companyMatches(p.organization.name,company,packet)&&roleScore(p.title??'',role)>0)
    .map(p=>({providerId:p.id,displayName:[p.first_name,p.last_name_obfuscated].filter(Boolean).join(' ')||'Name withheld',
     role:p.title??role,company:p.organization!.name,refreshedAt:p.last_refreshed_at??null,emailAvailable:p.has_email===true,
     limitations:candidateLimitations(p,role,company,packet),
     reason:'Provider-reported role/company match. Partial name and email availability do not establish an address or verified current employment.'}));
   for(const f of found)if(!candidates.some(c=>c.providerId===f.providerId))candidates.push(f);
   candidates=candidates.sort((a,b)=>roleScore(b.role,role)-roleScore(a.role,role)
    ||Number(b.emailAvailable&&isFresh(b.refreshedAt,90))-Number(a.emailAvailable&&isFresh(a.refreshedAt,90))).slice(0,5);
   const reachable=candidates.find(c=>c.emailAvailable&&roleScore(c.role,role)>=20&&isFresh(c.refreshedAt,90));
   record(key,step.titles,step.reason,parsedStep.data.people.length,
    !parsedStep.data.people.length?'no_results':reachable?'resolved':candidates.length?'no_reachable_candidate':'no_relevant_candidate');
   if(refresh)return pending('Requested fresh buyer search completed; candidates preserved. Resume contact resolution separately to check employment and verified work email.',candidates);
   if(reachable)break;
  }
  if(!candidates.length)return pending(anyPeople
   ?'People were returned for this company, but none held a role relevant to the researched service. Alternative role searches were exhausted.'
   :'No matching people returned across the bounded search plan; company potential remains unchanged.');
  const selected=candidates.find(c=>c.emailAvailable&&roleScore(c.role,role)>=20&&isFresh(c.refreshedAt,90));
  if(!selected)return pending(`Relevant people were found but none is reachable: ${candidateBlockSummary(candidates)}. Alternative role searches were exhausted; no contact was assumed.`,candidates);
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
