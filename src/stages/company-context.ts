import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Candidate,type Packet,type Evidence} from '../contracts/pipeline';
import {companyContextQuery} from '../domain/company-discovery';
import {discoveryPriority} from '../domain/policy';
export interface CompanyContextTools {
 companyEvidence?:(host:string)=>Promise<Evidence[]>;
 search:(key:string,query:string,country?:string,language?:string)=>Promise<z.infer<typeof Candidate>[]>;
 fetchEvidence:(url:string)=>Promise<Evidence>;
}
export async function collectCompanyContext(p:Packet,tools:CompanyContextTools):Promise<boolean>{
 const c=p.candidate!.providerCompany!;
 if(c.icp.status==='mismatch'){p.state='icp_mismatch';p.notes.push(...c.icp.reasons);return false;}
 if(!c.domain){p.state='company_context_pending';p.notes.push('Company domain unavailable; original attribution needs human assessment.');return false;}
 const valid=(e:Evidence)=>e.origin==='original'&&e.accountHost===c.domain&&Date.parse(e.retrievedAt)>=Date.now()-7*86400000&&Date.parse(e.retrievedAt)<=Date.now()+60000;
 const saved=await tools.companyEvidence?.(c.domain)??[];p.evidence=saved.filter(valid).slice(0,2).map(e=>({...e,id:randomUUID()}));
 if(p.evidence.length){p.notes.push('Reused recent original company evidence; no new context search.');p.state='evidence_collected';return true;}
 const results=await tools.search('company_context',companyContextQuery(c),p.candidate!.country,p.candidate!.language);
 const ranked=results.filter(r=>{try{const h=new URL(r.url).hostname.toLowerCase().replace(/^www\./,'');return (h===c.domain||h.endsWith('.'+c.domain))&&discoveryPriority(r)>=0;}catch{return false;}}).sort((a,b)=>discoveryPriority(b)-discoveryPriority(a));
 // Two public reads at most. A company landing page can supply a factual exploratory anchor.
 const urls=[...new Set([...ranked.map(r=>r.url),'https://'+c.domain])].slice(0,2);
 for(const url of urls){try{const e=await tools.fetchEvidence(url);if(valid(e))p.evidence.push(e);else p.notes.push('Fetched source did not establish original company attribution.');}catch(error){const reason=error instanceof Error&&/^[a-z0-9_]{1,80}$/.test(error.message)?error.message:'source_unavailable';p.notes.push(`Company source unavailable: ${reason}.`);}}
 if(!p.evidence.length){p.state='company_context_pending';p.notes.push('Identified company retained for human assessment; source limitations do not establish poor fit.');return false;}
 p.state='evidence_collected';return true;
}
