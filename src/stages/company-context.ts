import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Candidate,type Packet,type Evidence} from '../contracts/pipeline';
import {companyContextQuery} from '../domain/company-discovery';
import {discoveryPriority,firstPartyATS,hostOf} from '../domain/policy';
export interface CompanyContextTools {
 companyEvidence?:(host:string)=>Promise<Evidence[]>;
 search:(key:string,query:string,country?:string,language?:string)=>Promise<z.infer<typeof Candidate>[]>;
 fetchEvidence:(url:string)=>Promise<Evidence>;
}
/** A homepage states what a company does, never what it needs. Only a deeper page or an employer-attributed
 *  job posting counts as evidence of a current need. */
const needEvidence=(e:Evidence)=>{try{return e.source==='job_posting_web'||new URL(e.finalUrl||e.url).pathname.replace(/\/+$/,'').length>0;}catch{return false;}};
export async function collectCompanyContext(p:Packet,tools:CompanyContextTools):Promise<boolean>{
 const c=p.candidate!.providerCompany!;
 if(c.provider==='explorium'&&(c.icp.status!=='match'||c.intent.status!=='provider_reported')){p.state='company_assessment_pending';p.notes.push(...c.icp.unknowns,c.intent.reason);return false;}
 if(c.icp.status==='mismatch'){p.state='icp_mismatch';p.notes.push(...c.icp.reasons);return false;}
 if(!c.domain){p.state='company_context_pending';p.notes.push('Company domain unavailable; original attribution needs human assessment.');return false;}
 const valid=(e:Evidence)=>e.origin==='original'&&e.accountHost===c.domain&&Date.parse(e.retrievedAt)>=Date.now()-7*86400000&&Date.parse(e.retrievedAt)<=Date.now()+60000;
 const saved=await tools.companyEvidence?.(c.domain)??[];p.evidence=saved.filter(valid).slice(0,2).map(e=>({...e,id:randomUUID()}));
 if(p.evidence.length){p.notes.push('Reused recent original company evidence; no new context search.');p.state='evidence_collected';return true;}
 const results=await tools.search('company_context',companyContextQuery(c),p.candidate!.country,p.candidate!.language);
 const read=async(url:string)=>{try{const e=await tools.fetchEvidence(url);if(valid(e)){p.evidence.push(e);return;}p.notes.push('Fetched source did not establish original company attribution.');}catch(error){const reason=error instanceof Error&&/^[a-z0-9_]{1,80}$/.test(error.message)?error.message:'source_unavailable';p.notes.push(`Company source unavailable: ${reason}.`);}};
 // The company's own pages plus first-party ATS boards. valid() still enforces attribution after the fetch, so a
 // board posting counts only when its structured employer identity resolves to this company's domain.
 const ranked=results.filter(r=>{try{const h=hostOf(r.url);return (h===c.domain||h.endsWith('.'+c.domain)||firstPartyATS(h))&&discoveryPriority(r)>=0;}catch{return false;}}).sort((a,b)=>discoveryPriority(b)-discoveryPriority(a));
 for(const url of [...new Set(ranked.map(r=>r.url))].slice(0,2))await read(url);
 // Read the homepage unless a needful page was already found. Broad discovery is deliberate: a company without
 // public need evidence is still an exploration candidate, never an automatic rejection.
 if(!p.evidence.some(needEvidence))await read('https://'+c.domain);
 if(!p.evidence.length){p.state='company_context_pending';p.notes.push('Identified company retained for human assessment; source limitations do not establish poor fit.');return false;}
 if(!p.evidence.some(needEvidence))p.notes.push('Only general company pages were available; no page evidencing a current need was found. Treat this as an exploratory packet and frame need as unconfirmed.');
 p.state='evidence_collected';return true;
}
