import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Candidate,type Packet,type Evidence} from '../contracts/pipeline';
import {companyContextQuery} from '../domain/company-discovery';
import {discoveryPriority,firstPartyATS,hostOf,eventKey} from '../domain/policy';
import {topicRelevance} from '../domain/intent-topics';
import {relatedCompanyContext} from '../domain/company-research';
import {sourceFailure,type SourceAttempt} from '../capture/source-error';
export interface CompanyContextTools {
 companyEvidence?:(host:string)=>Promise<Evidence[]>;
 search:(key:string,query:string,country?:string,language?:string)=>Promise<z.infer<typeof Candidate>[]>;
 fetchEvidence:(url:string,onAttempt?:(attempt:SourceAttempt)=>void)=>Promise<Evidence>;
}
export async function collectCompanyContext(p:Packet,tools:CompanyContextTools):Promise<boolean>{
 const c=p.candidate!.providerCompany!;
 if(c.provider==='explorium'&&(c.icp.status!=='match'||c.intent.status!=='provider_reported')){p.state='company_assessment_pending';p.notes.push(...c.icp.unknowns,c.intent.reason);return false;}
 if(c.icp.status==='mismatch'){p.state='icp_mismatch';p.notes.push(...c.icp.reasons);return false;}
 if(!c.domain){p.state='company_context_pending';p.notes.push('Company domain unavailable; original attribution needs human assessment.');return false;}
 const owned=(host:string)=>host===c.domain||host.endsWith('.'+c.domain);
 // Preserve the source URL while attributing a company-owned subdomain to the company.
 const attribute=(e:Evidence)=>e.origin==='original'&&e.accountHost===hostOf(e.finalUrl)&&owned(e.accountHost)&&!firstPartyATS(e.accountHost)?{...e,accountHost:c.domain}:e;
 const valid=(e:Evidence)=>e.origin==='original'&&e.accountHost===c.domain&&Date.parse(e.retrievedAt)>=Date.now()-7*86400000&&Date.parse(e.retrievedAt)<=Date.now()+60000;
 const record=(a:SourceAttempt)=>{p.contextAttempts=[...(p.contextAttempts??[]).filter(v=>v.url!==a.url||v.code!==a.code||v.stage!==a.stage),a].slice(-12);};
 const seen=new Set<string>(),saved=[...p.evidence,...await tools.companyEvidence?.(c.domain)??[]].map(attribute).filter(valid).filter(e=>{const key=eventKey(e.finalUrl);if(seen.has(key))return false;seen.add(key);return true;});
 const related=saved.filter(e=>relatedCompanyContext(e,c));
 p.evidence=(related.length?related.slice(0,2):saved.slice(0,1)).map(e=>({...e,id:randomUUID()}));
 if(related.length){p.notes.push('Reused recent original evidence relevant to the matched topic; supported need still requires assessment.');p.state='evidence_collected';return true;}
 for(const attempt of p.contextAttempts??[])if(/403|robots_disallowed|unsafe/.test(attempt.code))seen.add(eventKey(attempt.url));
 let reads=0;
 const read=async(url:string)=>{const key=eventKey(url);if(reads>=4||seen.has(key)||p.evidence.length>=2)return;seen.add(key);reads++;
  try{const e=attribute(await tools.fetchEvidence(url,record));if(valid(e)){const finalKey=eventKey(e.finalUrl);if(!p.evidence.some(v=>eventKey(v.finalUrl)===finalKey))p.evidence.push(e);seen.add(finalKey);return;}record({url,stage:'attribution',code:'company_identity_unresolved'});p.notes.push('Fetched source did not establish original company attribution.');}catch(error){const detail=sourceFailure(error,url,'page');record(detail);p.notes.push(`Company source unavailable: ${detail.code}.`);}};
 const rank=(r:z.infer<typeof Candidate>)=>topicRelevance(r.title+' '+r.description,c)*30+(/implementation|migration|rollout|initiative|project|launch|hiring|integration|redesign/i.test(r.title+' '+r.description)?10:0)+(firstPartyATS(hostOf(r.url))?5:0);
 for(const pass of [0,1,2]){
  if(pass>0&&p.evidence.length)break;
  const alternate=pass===1;
  let results:z.infer<typeof Candidate>[];
  try{results=await tools.search('company_context_v3_'+pass,pass===2?'site:'+c.domain+' about company services':companyContextQuery(c,alternate),p.candidate!.country,p.candidate!.language);}
  catch(error){if(!(error instanceof Error)||error.message!=='budget_paused')throw error;p.notes.push('Paid context search paused by its budget guard; use saved evidence or the bounded company homepage read.');break;}
  const ranked=results.filter(r=>{try{const h=hostOf(r.url);return (owned(h)||firstPartyATS(h))&&discoveryPriority(r)>=0&&!seen.has(eventKey(r.url));}catch{return false;}}).sort((a,b)=>rank(b)-rank(a));
  // Keep capacity for a changed query or the company homepage if the first page fails.
  for(const candidate of ranked.slice(0,2)){await read(candidate.url);if(p.evidence.length)break;}
 }
 if(!p.evidence.length)await read('https://'+c.domain);
 if(!p.evidence.length){p.state='company_context_pending';p.notes.push('Identified company retained for human assessment; source limitations do not establish poor fit.');return false;}
 if(!p.evidence.some(e=>relatedCompanyContext(e,c)))p.notes.push('Only general company context was available. Need remains unconfirmed; the controlled limitation is included in model inputs.');
 p.state='evidence_collected';return true;
}
