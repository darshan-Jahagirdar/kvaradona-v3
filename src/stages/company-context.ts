import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Candidate,type Packet,type Evidence} from '../contracts/pipeline';
import {companyContextQuery} from '../domain/company-discovery';
import {discoveryPriority,firstPartyATS,hostOf,eventKey} from '../domain/policy';
import {topicRelevance} from '../domain/intent-topics';
import {relatedCompanyContext} from '../domain/company-research';
export interface CompanyContextTools {
 companyEvidence?:(host:string)=>Promise<Evidence[]>;
 search:(key:string,query:string,country?:string,language?:string)=>Promise<z.infer<typeof Candidate>[]>;
 fetchEvidence:(url:string)=>Promise<Evidence>;
}
export async function collectCompanyContext(p:Packet,tools:CompanyContextTools):Promise<boolean>{
 const c=p.candidate!.providerCompany!;
 if(c.provider==='explorium'&&(c.icp.status!=='match'||c.intent.status!=='provider_reported')){p.state='company_assessment_pending';p.notes.push(...c.icp.unknowns,c.intent.reason);return false;}
 if(c.icp.status==='mismatch'){p.state='icp_mismatch';p.notes.push(...c.icp.reasons);return false;}
 if(!c.domain){p.state='company_context_pending';p.notes.push('Company domain unavailable; original attribution needs human assessment.');return false;}
 const valid=(e:Evidence)=>e.origin==='original'&&e.accountHost===c.domain&&Date.parse(e.retrievedAt)>=Date.now()-7*86400000&&Date.parse(e.retrievedAt)<=Date.now()+60000;
 const seen=new Set<string>(),saved=[...p.evidence,...await tools.companyEvidence?.(c.domain)??[]].filter(valid).filter(e=>{const key=eventKey(e.finalUrl);if(seen.has(key))return false;seen.add(key);return true;});
 const related=saved.filter(e=>relatedCompanyContext(e,c));
 p.evidence=(related.length?related.slice(0,2):saved.slice(0,1)).map(e=>({...e,id:randomUUID()}));
 if(related.length){p.notes.push('Reused recent original evidence relevant to the matched topic; supported need still requires assessment.');p.state='evidence_collected';return true;}
 const results=await tools.search('company_context',companyContextQuery(c),p.candidate!.country,p.candidate!.language);
 let reads=0;
 const read=async(url:string)=>{const key=eventKey(url);if(reads>=2||seen.has(key)||p.evidence.length>=2)return;seen.add(key);reads++;
  try{const e=await tools.fetchEvidence(url);if(valid(e)){const finalKey=eventKey(e.finalUrl);if(!p.evidence.some(v=>eventKey(v.finalUrl)===finalKey))p.evidence.push(e);seen.add(finalKey);return;}p.notes.push('Fetched source did not establish original company attribution.');}catch(error){const reason=error instanceof Error&&/^[a-z0-9_]{1,80}$/.test(error.message)?error.message:'source_unavailable';p.notes.push(`Company source unavailable: ${reason}.`);}};
 const rank=(r:z.infer<typeof Candidate>)=>topicRelevance(r.title+' '+r.description,c)*30+(/implementation|migration|rollout|initiative|project|launch|hiring|integration|redesign/i.test(r.title+' '+r.description)?10:0)+(firstPartyATS(hostOf(r.url))?5:0);
 const ranked=results.filter(r=>{try{const h=hostOf(r.url);return (h===c.domain||h.endsWith('.'+c.domain)||firstPartyATS(h))&&discoveryPriority(r)>=0;}catch{return false;}}).sort((a,b)=>rank(b)-rank(a));
 for(const r of ranked){if(reads>=2||p.evidence.length>=2)break;await read(r.url);}
 if(!p.evidence.length)await read('https://'+c.domain);
 if(!p.evidence.length){p.state='company_context_pending';p.notes.push('Identified company retained for human assessment; source limitations do not establish poor fit.');return false;}
 if(!p.evidence.some(e=>relatedCompanyContext(e,c)))p.notes.push('Only general company context was available. Need remains unconfirmed; the controlled limitation is included in model inputs.');
 p.state='evidence_collected';return true;
}
