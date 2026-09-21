import {validStructuredFact} from './structured-evidence';
import type {Packet} from '../contracts/pipeline';
import {intentIcp} from './intent-target';
import {discoveryExcludedDomains} from './explorium-icp';
/** Selective eligibility resolution. Estimates remain estimates; disagreeing observations stay unresolved. */
export function resolveCompanyFacts(p:Packet):NonNullable<Packet['factResolution']>{
 const c=p.candidate?.providerCompany;if(!c)return {status:'unresolved',questions:['Establish company identity.'],conflicts:[],reused:[]};
 // A person accepted this account into a named cohort, so an attribute we simply do not know must not hold
 // research. Contradicted attributes and conflicting observations still stop it. Unknowns stay unknown.
 const accepted=p.eligibility?.basis==='user_accepted_cohort';
 const target=p.eligibility?.employeeRange??intentIcp.employeeRange;
 // An open-ended accepted band has no upper bound; do not substitute the global ceiling for it.
 const targetMin=target.min,targetMax=target.max??Number.POSITIVE_INFINITY;
 const approvedCountries=p.eligibility?.countries??intentIcp.countries.map(x=>x.code);
 const observations=(p.providerObservations??[]).filter(o=>o.companyHost===c.domain&&o.companyId===c.id);
 const originalFacts=p.evidence.filter(e=>e.origin==='original'&&e.accountHost===c.domain).flatMap(e=>(e.companyFacts??[]).filter(f=>validStructuredFact(e,f)));
 const fields=[...observations,...originalFacts];
 const questions:string[]=[],conflicts:string[]=[],reused=['Saved provider company attributes'];let mismatch=false;
 const bands=[c.employeeRange,...fields.filter(o=>o.field==='employeeRange').map(o=>String(o.value))].filter(Boolean).flatMap(v=>{const m=v!.match(/^(\d+)-(\d+)$/);return m?[[+m[1],+m[2]]]:[];});
 const counts=[c.employees,...fields.filter(o=>o.field==='employees').map(o=>Number(o.value))].filter((v):v is number=>v!==null&&Number.isFinite(v));
 const ranges=[...bands,...counts.map(v=>[v,v])],verdicts=ranges.map(([lo,hi])=>hi<targetMin||lo>targetMax?'outside':lo>=targetMin&&hi<=targetMax?'inside':'crossing');
 if(new Set(verdicts.filter(v=>v!=='crossing')).size>1)conflicts.push('Saved employee observations disagree across the selected ICP boundary.');
 else if(verdicts.length&&verdicts.every(v=>v==='outside'))mismatch=true;
 else if(!verdicts.includes('inside')&&!accepted)questions.push('Resolve missing or boundary-crossing employee estimate only if eligibility can change.');
 const countries=[c.headquartersCountry,...fields.filter(o=>o.field==='country').map(o=>String(o.value))].filter((v):v is string=>Boolean(v));
 const canonical=(v:string)=>intentIcp.countries.find(x=>[x.name,x.code].some(n=>n.toLowerCase()===v.toLowerCase()))?.code??v.toLowerCase();
 // An accepted cohort may list countries by name or by code, so both sides are canonicalised.
 const approved=(v:string)=>approvedCountries.some(entry=>canonical(entry).toLowerCase()===canonical(v).toLowerCase());
 if(new Set(countries.map(canonical)).size>1)conflicts.push('Saved headquarters observations conflict.');
 else if(!countries.some(approved)&&(countries.length>0||!accepted))questions.push(countries.length
  ?'Reported headquarters is outside the approved countries for this cohort; acceptance does not override contradicting data.'
  :'Verify headquarters or relevant operating geography against approved countries.');
 if(!c.industry&&!fields.some(o=>o.field==='industry')&&!accepted){questions.push('Resolve missing industry classification.');}
 // A provider's historical description warning is a QUESTION about classification, not a finding
 // that the company is out of scope. It is preserved and reported, but it is answerable by original
 // evidence, so it must not end the company's workflow before any research has happened.
 const classification:string[]=[];
 for(const q of c.icp.unknowns)if(/conflict|description/i.test(q)){questions.push(q);classification.push(q);}
 if(!c.domain)questions.push('Resolve company domain.');
 if(c.domain&&discoveryExcludedDomains.some(d=>c.domain===d||c.domain!.endsWith('.'+d)))mismatch=true;
 if(accepted)reused.push(`Cohort acceptance: ${p.eligibility!.cohort}. Unknown attributes remain unknown and unverified.`);
 if(originalFacts.length)reused.push(`${originalFacts.length} original structured company facts`);
 if(observations.length)reused.push(`${observations.length} attributable saved provider fields`);
 const status=mismatch&&!conflicts.length?'mismatch':questions.length||conflicts.length?'unresolved':'match';
 const open=mismatch&&!conflicts.length?[]:questions;
 // Answerable by evidence when nothing contradicts the cohort and every open item is a
 // classification question. A conflict or a contradicting attribute is not answerable this way.
 const evidenceCanResolve=status==='unresolved'&&!conflicts.length&&open.length>0&&open.every(q=>classification.includes(q));
 return {status,questions:open,conflicts,reused,classification,evidenceCanResolve};
}
