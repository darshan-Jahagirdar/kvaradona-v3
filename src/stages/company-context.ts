import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Candidate,type Packet,type Evidence} from '../contracts/pipeline';
import {companyContextQueries} from '../domain/company-discovery';
import {discoveryPriority,firstPartyATS,hostOf,eventKey,boilerplatePage,productCataloguePage} from '../domain/policy';
import {topicRelevance} from '../domain/intent-topics';
import {contextAdequacy} from '../domain/company-research';
import {attributeCompanyEvidence,usableCompanyEvidence,identityOwnedHost,redirectAliasEvidence} from '../domain/evidence-attribution';
import {companyIdentity} from '../domain/identity-resolution';
import {resolveCompanyFacts} from '../domain/fact-resolution';
import {sourceFailure,type SourceAttempt} from '../capture/source-error';
export interface CompanyContextTools {
 companyEvidence?:(host:string)=>Promise<Evidence[]>;
 search:(key:string,query:string,country?:string,language?:string)=>Promise<z.infer<typeof Candidate>[]>;
 fetchEvidence:(url:string,onAttempt?:(attempt:SourceAttempt)=>void)=>Promise<Evidence>;
}
export async function collectCompanyContext(p:Packet,tools:CompanyContextTools):Promise<boolean>{
 const c=p.candidate!.providerCompany!;
 p.factResolution=resolveCompanyFacts(p);
 if(p.factResolution.status==='mismatch'){p.state='icp_mismatch';p.notes.push('Saved attributes place this company outside the current target; no exact-count enrichment is needed.');return false;}
 if(p.factResolution.status==='unresolved'&&!p.factResolution.evidenceCanResolve){
  p.state='company_assessment_pending';p.notes.push(...p.factResolution.questions,...p.factResolution.conflicts);
  p.pendingResolution={reason:'classification_conflict',attempts:(p.pendingResolution?.attempts??0),
   detail:[...p.factResolution.questions,...p.factResolution.conflicts].join(' '),
   nextAction:'ask_reviewer',at:new Date().toISOString(),
   question:'Does this company belong in this campaign? Saved attributes leave an unresolved conflict that original evidence cannot settle.'};
  return false;}
 if(p.factResolution.status==='unresolved'){
  // Every open item is a classification question. Collect original evidence first and judge fit on
  // what the company actually publishes; the historical warning is preserved either way.
  p.notes.push(...p.factResolution.questions,'Classification question retained; original company evidence is collected before deciding fit.');}
 if(!c.domain){p.state='company_context_pending';return false;}
 // One supported identity for the whole stage: the canonical domain evidence stays grouped under,
 // plus any domain already established as this company's current address.
 const identity=()=>({domain:c.domain,name:c.name,aliases:companyIdentity(p,c.domain).aliases});
 const valid=(e:Evidence)=>usableCompanyEvidence(e,identity(),p.evidence);
 // Legal boilerplate attributes to the company but researches nothing, so it may not end retrieval or stand in for context.
 const substantive=(e:Evidence)=>valid(e)&&!boilerplatePage(e.finalUrl,e.title);
 const record=(a:SourceAttempt)=>{p.contextAttempts=[...(p.contextAttempts??[]).filter(v=>v.url!==a.url||v.code!==a.code||v.stage!==a.stage),a].slice(-12);};
 // Keep old IDs and dates, including evidence cited by preserved drafts and specialist findings.
 const external=await tools.companyEvidence?.(c.domain)??[];
 const saved=[...p.evidence,...external.filter(e=>!p.evidence.some(v=>v.contentHash===e.contentHash&&v.accountHost===e.accountHost)).map(e=>({...e,id:randomUUID(),derivedFromEvidenceId:e.id}))].map(e=>attributeCompanyEvidence(e,identity(),p.evidence));
 p.evidence=[...new Map([...p.evidence,...saved].map(e=>[e.id,e])).values()];
 const seen=new Set(p.evidence.filter(valid).map(e=>eventKey(e.finalUrl)));
 for(const a of p.contextAttempts??[])if(/403|robots_disallowed|unsafe/.test(a.code)&&!p.recovery?.retryUrls?.includes(a.url))seen.add(eventKey(a.url));
 const plan=companyContextQueries(c,p.researchRequest?.question,p.candidate?.description??''),queries:string[]=[];
 const finish=(stop:'adequate'|'exhausted'|'execution_hold')=>{
  const coverage=contextAdequacy(p).coverage;p.contextSearch={version:'kvd101',question:plan[0].question,queries,stop,coverage};
  const ready=p.evidence.some(substantive);p.state=ready?'evidence_collected':'company_context_pending';
  if(!ready)p.notes.push('Company retained: unavailable evidence is not commercial rejection.');
  return ready;
 };
 if(contextAdequacy(p).adequate&&!p.researchRequest)return finish('adequate');
 let reads=0;
 const read=async(url:string)=>{const key=eventKey(url);if(reads>=4||seen.has(key))return;seen.add(key);reads++;
  try{const fetched=await tools.fetchEvidence(url,record);
   const alias=redirectAliasEvidence(fetched,identity());
   // Attribute first, then record the alias against the evidence record that is actually kept.
   // Attribution mints a new ID when it rebinds, so recording `fetched.id` left a dangling reference.
   const e=attributeCompanyEvidence(fetched,alias?{...identity(),aliases:[...identity().aliases,alias.to]}:identity(),p.evidence);
   if(alias&&!p.identityResolution){p.identityResolution={...alias,evidenceId:e.id,at:new Date().toISOString()};
    p.notes.push(`Company domain resolved: ${alias.from} redirects to ${alias.to}, and that page carries ${c.name}'s own structured identity. Both signals were required. The resolved address is now used for research, website capture, contacts and exclusions; the provider's recorded domain is unchanged.`);}
   if(valid(e)){if(!p.evidence.some(v=>eventKey(v.finalUrl)===eventKey(e.finalUrl)&&v.contentHash===e.contentHash))p.evidence.push(e);seen.add(eventKey(e.finalUrl));}
   else{
    record({url,stage:'attribution',code:'company_identity_unresolved'});
    // Keep the capture as recovery material, with its reason, instead of discarding it. It is not
    // citable evidence and is never used to support a claim.
    p.rejectedCaptures=[...(p.rejectedCaptures??[]).filter(v=>v.contentHash!==fetched.contentHash),
     {url,finalUrl:fetched.finalUrl,title:fetched.title.slice(0,300),contentHash:fetched.contentHash,
      retrievedAt:fetched.retrievedAt,reason:'company_identity_unresolved'}].slice(-8);
   }}
  catch(error){record(sourceFailure(error,url,'page'));}};
 const rank=(r:z.infer<typeof Candidate>)=>topicRelevance(r.title+' '+r.description,c)*30+(/implementation|migration|rollout|initiative|project|launch|hiring|integration|redesign/i.test(r.title+' '+r.description)?10:0)+(firstPartyATS(hostOf(r.url))?5:0)-(boilerplatePage(r.url,r.title)?60:0)-(productCataloguePage(r.url,r.title)?15:0);
 for(const [i,pass] of plan.entries()){
  if(reads>=4)break;
  let results:z.infer<typeof Candidate>[];queries.push(pass.query);
  try{results=await tools.search('company_context_kvd101_'+i,pass.query,p.candidate!.country,p.candidate!.language);}
  catch(error){if(!(error instanceof Error)||!['budget_paused','provider_unverified','live_disabled'].includes(error.message))throw error;
   // A paid-search guard must not also stop free retrieval: the company's own front door is still
   // reachable, and a company with no readable source is an assessment candidate, not a rejection.
   p.notes.push(`Paid search stopped by a budget guard (${error.message}); the free company front door was still read.`);
   if(!p.evidence.some(substantive))await read('https://'+(companyIdentity(p,c.domain).effective??c.domain));
   return finish('execution_hold');}
  const ranked=results.filter(r=>{try{return discoveryPriority(r)>=0&&!seen.has(eventKey(r.url))&&(identityOwnedHost(hostOf(r.url),identity())||firstPartyATS(hostOf(r.url))||r.title.toLowerCase().includes(c.name.toLowerCase()));}catch{return false;}}).sort((a,b)=>rank(b)-rank(a));
  for(const candidate of ranked.slice(0,2)){await read(candidate.url);if(contextAdequacy(p).adequate)return finish('adequate');}
 }
 if(!p.evidence.some(substantive))await read('https://'+(companyIdentity(p,c.domain).effective??c.domain));
 return finish('exhausted');
}
