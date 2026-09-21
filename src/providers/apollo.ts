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
/** A title that carries the decision, including the named owner a small company routes this to.
 *  Founder and owner belong here: refusing them is what makes an alternative search useless for a
 *  company whose function is not separately staffed. */
export const seniorTitle=(title:string)=>/\b(head|director|vice president|chief|manager|lead|founder|co-?founder|owner|president|principal|partner)\b/i.test(expandRole(title));
/** Score a title against an EXPLICIT accepted-role list.
 *
 *  Each search step carries its own accepted roles, so an alternative is judged by what it actually
 *  asked for. Scoring a Web Manager or a Founder against the first step's sentence is what threw
 *  away the alternatives' own hits. */
export function roleScoreFor(title:string,accepted:readonly string[]){
 const expanded=expandRole(title).replace(/[,/&-]+/g,' ').replace(/\s+/g,' ');
 const matches=accepted.some(t=>expanded.toLowerCase().includes(t.toLowerCase()));
 return matches?10+(seniorTitle(expanded)?10:0):0;
}
export function roleScore(title:string,role:string){return roleScoreFor(title,contactTitles(expandRole(role)));}
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

/** At most two contact reveals per account across every resume, counting attempts whose outcome is
 *  unknown. The ceiling is enforced against the account's recorded operations, not against one
 *  person's history, so a second candidate cannot quietly become a third reveal. */
export const REVEAL_CEILING=2;

/** One step of the bounded search plan. `accepted` is the role criteria this step is judged by, in
 *  candidate selection AND in enrichment verification, so the two can never disagree. */
export interface ContactStep {key:string;titles:string[];accepted:string[];reason:string;}

/** The bounded search plan for one company and service: the roles A2 asked for, then at most two
 *  MEANINGFULLY different alternatives. Each alternative must add titles the earlier attempts did
 *  not already search, so a resume never re-buys the same question. */
export function contactSearchPlan(role:string,service:string,intentIcpOnly=false):ContactStep[]{
 const base=contactTitles(expandRole(role));
 // A discovery run keeps its persona policy. Applying it is a restriction on who may be searched and
 // revealed at all, so it replaces the plan rather than being checked after a reveal is bought.
 if(intentIcpOnly){
  const titles=buyerSearchTitles(role,true);
  return [{key:'contact_search',titles,accepted:titles,
   reason:'Discovery persona policy applies to this run, so only the approved buyer titles are searched.'}];
 }
 const text=`${role} ${service}`.toLowerCase();
 const web=/website|web |cro|conversion|journey|seo|aeo|search|content|digital experience/.test(text);
 const alternatives:{titles:string[];reason:string}[]=[];
 // 1. The people who own the work itself, rather than the function that sponsors it.
 alternatives.push(web
  ?{titles:['web','website','demand generation','lifecycle','content','product marketing'],
    reason:'The first search covered the sponsoring function. This one looks for the people who own the web and demand surfaces the offer is about.'}
  :{titles:['revenue operations','marketing operations','business systems','demand generation'],
    reason:'The first search covered the sponsoring function. This one looks for the operations owners of the proposed work.'});
 // 2. A named accountable owner, for a company where the function may not be separately staffed.
 alternatives.push({titles:['head of marketing','marketing director','chief marketing officer','founder','managing director','chief executive officer'],
  reason:'No reachable owner of the function was found, so this looks for the named senior owner this work would be routed to.'});
 const seen=new Set(base.map(t=>t.toLowerCase()));
 const plan:ContactStep[]=[{key:'contact_search',titles:base,accepted:base,
  reason:'Roles derived from the campaign and the researched service.'}];
 for(const alt of alternatives){
  const fresh=alt.titles.filter(t=>!seen.has(t.toLowerCase()));
  if(!fresh.length)continue;
  for(const t of fresh)seen.add(t.toLowerCase());
  plan.push({key:`contact_search_alt_${plan.length}`,titles:fresh,accepted:fresh,reason:alt.reason});
 }
 return plan.slice(0,3);
}

export type CandidateLimitation='employer_unconfirmed'|'role_not_relevant'|'below_buyer_seniority'|'provider_data_stale'|'no_provider_email'|'outside_discovery_persona'|'enrichment_unverified';
/** Why this person cannot be used, stated per requirement rather than as one opaque refusal.
 *  `criteria` is the accepted role list of the step that found them. */
export function candidateLimitations(p:{title:string|null;has_email?:boolean;last_refreshed_at?:string|null;organization:{name:string}|null},
 criteria:string|readonly string[],company:string,packet?:Packet,intentIcpOnly=false){
 const accepted=typeof criteria==='string'?contactTitles(expandRole(criteria)):criteria;
 const limitations:CandidateLimitation[]=[];
 if(!p.organization||!companyMatches(p.organization.name,company,packet))limitations.push('employer_unconfirmed');
 const score=roleScoreFor(p.title??'',accepted);
 if(score<=0)limitations.push('role_not_relevant');
 else if(score<20)limitations.push('below_buyer_seniority');
 if(intentIcpOnly&&!intentBuyerTitle(p.title??''))limitations.push('outside_discovery_persona');
 if(!isFresh(p.last_refreshed_at??null,90))limitations.push('provider_data_stale');
 if(p.has_email!==true)limitations.push('no_provider_email');
 return limitations;
}

const limitationText:Record<string,string>={
 employer_unconfirmed:'the provider does not place them at this company',
 role_not_relevant:'their title does not match the criteria that found them',
 below_buyer_seniority:'their title is relevant but below the buyer seniority this offer needs',
 provider_data_stale:'the provider record is older than 90 days',
 no_provider_email:'the provider reports no work email for them',
 outside_discovery_persona:'their title is outside the discovery persona policy this run must keep',
 enrichment_unverified:'a settled reveal did not confirm the exact person, current employer, relevant role and verified work-domain email',
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
export function searchParams(host:string,titles:readonly string[]){return {'q_organization_domains_list[]':[host],'person_titles[]':[...titles],include_similar_titles:'true',page:'1',per_page:'25'};}
export function enrichmentParams(host:string,personId:string){return {id:personId,domain:host,reveal_personal_emails:'false',reveal_phone_number:'false',run_waterfall_email:'false',run_waterfall_phone:'false'};}
/** A dispatched or ambiguous operation, or a settled one with unknown cost. A plain reservation that
 *  was never dispatched is NOT uncertain and does not hold the account. */
const uncertain=(o:SavedOperation)=>o.state==='dispatched'||o.state==='ambiguous'||(o.state==='succeeded'&&(o.actual_usd===null||o.actual_usd===undefined));
type Cand=NonNullable<Contact['candidates']>[number];
export class ApolloContacts {
 constructor(private operations:ContactOperations,private allowance:FreeContactAllowance|null,private request:typeof fetch=fetch,private history:{operations:SavedOperation[]}={operations:[]}){}
 private call(key:string,path:string,params:Record<string,string|string[]>,units:number){return callApollo(this.operations,this.request,key,path,params,units);}

 async resolve(host:string,role:string,company:string,intentIcpOnly=false,packet?:Packet,service=''):Promise<Contact>{
  if(!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host))throw new Error('invalid_account_domain');
  const pending=(reason:string,candidates:Contact['candidates']=[],emailStatus?:Contact['emailStatus']):Contact=>
   ({...contactPending(role,reason),source:'apollo',candidates,...(emailStatus?{emailStatus}:{})});
  const ops=this.history.operations.filter(o=>!o.provider||o.provider==='apollo');
  const contactOp=(o:SavedOperation)=>/:contact_(search|enrichment)/.test(o.operation_key??'');
  // An account whose contact work has an unknown outcome is never worked around: not by a new key,
  // not by a different question, and not by a different person.
  const held=ops.find(o=>contactOp(o)&&uncertain(o));
  const settledFor=(requestHash:string)=>ops.find(o=>o.request_hash===requestHash&&o.state==='succeeded'&&o.actual_usd!==null&&o.actual_usd!==undefined);

  const refresh=packet?.contactSearchRequest&&!packet.contactSearchRequest.completedAt?packet.contactSearchRequest:null;
  if(refresh&&refresh.reason.trim().length<20)return pending('A specific reason for refreshing saved buyer criteria or stale/exhausted candidates is required.');

  const plan:ContactStep[]=refresh
   ?[{key:'contact_search_refresh_'+refresh.requestId,titles:buyerSearchTitles(role,intentIcpOnly),
      accepted:buyerSearchTitles(role,intentIcpOnly),reason:'Requested fresh buyer search.'}]
   :contactSearchPlan(role,service,intentIcpOnly);

  // The plan, its criteria and its counters are persisted and authoritative. A resume follows the
  // SAME plan; a changed company, service or role starts a new one rather than silently reusing
  // answers to a different question.
  let revealsUsed=ops.filter(o=>/:contact_enrichment/.test(o.operation_key??'')).length;
  if(packet){
   const saved=packet.contactPlan;
   const same=Boolean(saved&&saved.host===host&&saved.role===role&&saved.service===service);
   packet.contactPlan={host,role,service,steps:plan.map(s=>({key:s.key,titles:s.titles.slice(0,8)})),
    reveals:Math.max(revealsUsed,same?saved!.reveals??0:0),resolvedContact:false,
    attempts:same&&saved?saved.attempts:[]};
  }
  const record=(step:ContactStep,returned:number,outcome:'no_results'|'no_relevant_candidate'|'no_reachable_candidate'|'candidate_found'|'blocked')=>{
   if(!packet?.contactPlan)return;
   packet.contactPlan.attempts=[...packet.contactPlan.attempts.filter(a=>a.key!==step.key),
    {key:step.key,titles:step.titles.slice(0,8),reason:step.reason,at:new Date().toISOString(),returned,outcome}].slice(-3);
  };
  const finish=(c:Contact)=>{if(packet?.contactPlan){packet.contactPlan.reveals=revealsUsed;packet.contactPlan.resolvedContact=c.state==='resolved';}return c;};

  let candidates:Cand[]=[],anyPeople=false;
  const fallbackCriteria=contactTitles(expandRole(role));
  const score=(c:Cand)=>roleScoreFor(c.role,c.criteria?.length?c.criteria:fallbackCriteria);
  const reachable=()=>candidates.filter(c=>c.emailAvailable&&score(c)>=20&&isFresh(c.refreshedAt,90)
   &&(!intentIcpOnly||intentBuyerTitle(c.role))&&!(c.limitations??[]).includes('enrichment_unverified'));

  for(const step of plan){
   const requestHash=hash({endpoint:'mixed_people/api_search',params:searchParams(host,step.titles)});
   const prior=settledFor(requestHash);
   let response:{httpStatus:number;body:unknown};
   if(prior&&isFresh(prior.created_at,90)){
    // Reuse is bound to the exact request: this domain, these titles, this policy. The newest
    // response for some other criteria is a different question and is never substituted.
    const parsed=Envelope.safeParse(prior.response);
    if(!parsed.success){record(step,0,'blocked');return finish(pending('A saved contact search for these exact criteria cannot be read; no repeat search was bought.',candidates));}
    response=parsed.data;
   }else if(held){
    record(step,0,'blocked');
    return finish(pending('An earlier contact operation for this account has an unresolved operation; no automatic redispatch.',candidates));
   }else{
    try{response=await this.call(step.key,'mixed_people/api_search',searchParams(host,step.titles),0);}
    catch(e){if(e instanceof Error&&/^(provider_unverified|live_disabled|budget_paused)$/.test(e.message)){
     record(step,0,'blocked');
     return finish(pending('Apollo search is not enabled within the current verified limits.',candidates));}throw e;}
   }
   if(response.httpStatus!==200){record(step,0,'blocked');return finish(pending(httpReason(response.httpStatus),candidates));}
   const parsedStep=Search.safeParse(response.body);
   if(!parsedStep.success){record(step,0,'blocked');return finish(pending('Apollo search returned an unrecognized response; no contact assumed.',candidates));}
   anyPeople=anyPeople||parsedStep.data.people.length>0;
   // Everyone the provider actually places at this company is kept, judged by THIS step's criteria,
   // with their limitations named. A junior or email-less person stays visible; they are never
   // promoted to a resolved contact.
   const found=parsedStep.data.people
    .filter(p=>p.organization&&companyMatches(p.organization.name,company,packet)&&roleScoreFor(p.title??'',step.accepted)>0)
    .map(p=>({providerId:p.id,displayName:[p.first_name,p.last_name_obfuscated].filter(Boolean).join(' ')||'Name withheld',
     role:p.title??role,company:p.organization!.name,refreshedAt:p.last_refreshed_at??null,emailAvailable:p.has_email===true,
     criteria:step.accepted.slice(0,16),
     limitations:candidateLimitations(p,step.accepted,company,packet,intentIcpOnly),
     reason:`Provider-reported match for the ${step.key==='contact_search'?'primary':'alternative'} role criteria (${step.accepted.slice(0,4).join(', ')}). Partial name and email availability do not establish an address or verified current employment.`}));
   for(const f of found)if(!candidates.some(c=>c.providerId===f.providerId))candidates.push(f);
   candidates=candidates.sort((a,b)=>score(b)-score(a)
    ||Number(b.emailAvailable&&isFresh(b.refreshedAt,90))-Number(a.emailAvailable&&isFresh(a.refreshedAt,90))).slice(0,5);
   // A found candidate is not a resolved contact. Only enrichment can record that.
   record(step,parsedStep.data.people.length,
    !parsedStep.data.people.length?'no_results':reachable().length?'candidate_found':candidates.length?'no_reachable_candidate':'no_relevant_candidate');
   if(refresh)return finish(pending('Requested fresh buyer search completed; candidates preserved. Resume contact resolution separately to check employment and verified work email.',candidates));
   if(reachable().length)break;
  }
  if(!candidates.length)return finish(pending(anyPeople
   ?'People were returned for this company, but none held a role relevant to the criteria searched. Alternative role searches were exhausted.'
   :'No matching people returned across the bounded search plan; company potential remains unchanged.'));
  if(!reachable().length)return finish(pending(`Relevant people were found but none is reachable: ${candidateBlockSummary(candidates)}. Alternative role searches were exhausted; no contact was assumed.`,candidates));

  const mark=(c:Cand,limitation:CandidateLimitation)=>{c.limitations=[...new Set([...(c.limitations??[]),limitation])] as Cand['limitations'];};
  let lastStatus:Contact['emailStatus']|undefined;
  // A settled but unusable reveal exhausts THAT PERSON, not the account. The next suitable candidate
  // is considered within the same authorized ceiling.
  for(const selected of reachable()){
   const params=enrichmentParams(host,selected.providerId),requestHash=hash({endpoint:'people/match',params});
   const prior=ops.find(o=>o.request_hash===requestHash);
   let enriched;
   if(prior&&uncertain(prior))return finish(pending('An earlier reveal for this person is unresolved; no repeat reveal.',candidates));
   if(prior?.state==='succeeded'){
    if(!isFresh(prior.created_at,90)){mark(selected,'provider_data_stale');continue;}
    const parsed=Envelope.safeParse(prior.response);
    if(!parsed.success){mark(selected,'enrichment_unverified');continue;}
    enriched=parsed.data;
   }else{
    if(held)return finish(pending('An earlier contact operation for this account has an unresolved operation; no reveal was attempted.',candidates));
    if(revealsUsed>=REVEAL_CEILING)return finish(pending(`This account has already used its ${REVEAL_CEILING} authorized reveals, counting attempts whose outcome is unknown. Candidates are preserved; no further reveal was attempted.`,candidates));
    if(!this.allowance?.verifiedFree||this.allowance.remaining<1||Date.parse(this.allowance.expiresAt)<=Date.now()||!Number.isFinite(Date.parse(this.allowance.expiresAt))||this.allowance.evidence.trim().length<20)return finish(pending('Relevant buyer candidate found. Email enrichment awaits a verified free credit allowance; no reveal attempted.',candidates));
    const key=revealsUsed===0?'contact_enrichment':`contact_enrichment_${revealsUsed+1}`;
    try{enriched=await this.call(key,'people/match',params,1);}
    catch(e){if(e instanceof Error&&/^(free_quota_unverified_or_exhausted|provider_unverified|live_disabled|budget_paused)$/.test(e.message))return finish(pending('The free enrichment allowance is unavailable or exhausted; candidate preserved.',candidates));throw e;}
    revealsUsed++;
   }
   if(enriched.httpStatus!==200)return finish(pending(httpReason(enriched.httpStatus),candidates));
   const result=z.object({person:Person.nullable()}).safeParse(enriched.body);
   if(!result.success||!result.data.person){mark(selected,'enrichment_unverified');continue;}
   const person=result.data.person;let employerHost:string|null=null;
   try{employerHost=person.organization?.primary_domain?hostOf('https://'+person.organization.primary_domain):person.organization?.website_url?hostOf(person.organization.website_url):null;}catch{}
   const current=person.employment_history?.some(e=>e.current===true&&!e.end_date&&e.organization_id===person.organization?.id&&Boolean(e.organization_id));
   // Verification uses the SAME accepted criteria that admitted this candidate.
   const accepted=selected.criteria?.length?selected.criteria:fallbackCriteria;
   const verified=person.id===selected.providerId&&employerHost===host&&companyMatches(person.organization?.name??'',company,packet)&&current&&roleScoreFor(person.title??'',accepted)>=20&&(!intentIcpOnly||intentBuyerTitle(person.title??''));
   const email=z.string().email().safeParse(person.email);
   const emailStatus=person.email_status==='verified'?'provider_verified':/catch.?all/i.test(person.email_status??'')?'catch_all':person.email_status==='invalid'?'invalid':'unknown';
   lastStatus=emailStatus;
   if(!verified||!person.name||!email.success||email.data.split('@')[1].toLowerCase()!==host||emailStatus!=='provider_verified'){mark(selected,'enrichment_unverified');continue;}
   return finish({name:person.name,role:person.title!,email:email.data,emailStatus,employmentEvidence:`Apollo person ${person.id}: current employment at ${person.organization!.name} (${host}); provider reported, checked ${new Date().toISOString()}.`,source:'apollo',observedAt:prior?new Date(prior.created_at).toISOString():new Date().toISOString(),state:'resolved',reason:'Apollo reports a verified work email and matching current employment. This is provider evidence; relationship and sending approval checks still apply.',candidates});
  }
  return finish(pending(`Enrichment did not confirm the exact person, current employer, relevant role and verified work-domain email for any reachable candidate: ${candidateBlockSummary(candidates)}. No sendable recipient selected.`,candidates,lastStatus));
 }
}
