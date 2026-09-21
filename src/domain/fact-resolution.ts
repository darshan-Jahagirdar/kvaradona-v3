import {validStructuredFact} from './structured-evidence';
import type {Packet} from '../contracts/pipeline';
import {intentIcp} from './intent-target';
import {discoveryExcludedDomains} from './explorium-icp';
import {companyIdentity} from './identity-resolution';
/** Case- and punctuation-insensitive containment either way, so "Media" and "Online media and
 *  technology news" are the same classification and "Financial services" is not. */
const industryKey=(v:string)=>v.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
function industryMatches(configured:string,published:string){
 const a=industryKey(configured),b=industryKey(published);
 return Boolean(a)&&Boolean(b)&&(a===b||a.includes(b)||b.includes(a));
}
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
 const identity=companyIdentity(p,c.domain);
 const observations=(p.providerObservations??[]).filter(o=>o.companyHost===c.domain&&o.companyId===c.id);
 const originalPages=p.evidence.filter(e=>e.origin==='original'&&identity.hosts.includes(e.accountHost??''));
 const originalFacts=originalPages.flatMap(e=>(e.companyFacts??[]).filter(f=>validStructuredFact(e,f)));
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
 // An exclusion applies to the company, so it applies at every address the company is known at.
 // A supported domain move must not step around a list the old domain was on, or vice versa.
 if(identity.hosts.some(h=>discoveryExcludedDomains.some(d=>h===d||h.endsWith('.'+d))))mismatch=true;
 if(accepted)reused.push(`Cohort acceptance: ${p.eligibility!.cohort}. Unknown attributes remain unknown and unverified.`);
 if(originalFacts.length)reused.push(`${originalFacts.length} original structured company facts`);
 if(observations.length)reused.push(`${observations.length} attributable saved provider fields`);
 // Reassess the historical warning against the APPLICABLE POLICY, not merely against the existence
 // of an industry value. Knowing what a company publishes is not the same as it fitting this
 // campaign: a published industry settles the warning only where a restriction is actually
 // configured to judge it against. Where none is, the fit stays provisional and says so.
 const classifyingFact=originalFacts.find(f=>f.field==='industry');
 const allowedIndustries=p.eligibility?.industries?.filter(v=>v.trim().length>0)??null;
 const published=classifyingFact?String(classifyingFact.value):null;
 const industryVerdict:'no_published_industry'|'not_configured'|'inside'|'outside'=
  !published?'no_published_industry'
  :!allowedIndustries?.length?'not_configured'
  :allowedIndustries.some(a=>industryMatches(a,published))?'inside':'outside';
 let addressed=false;
 if(classification.length&&published){
  if(industryVerdict==='inside'){
   addressed=true;
   for(const q of classification){const i=questions.indexOf(q);if(i>=0)questions.splice(i,1);}
   reused.push(`Historical classification warning reassessed: the company publishes industry "${published.slice(0,80)}", which is inside this campaign's configured industries. The provider's warning is retained as history.`);
  }else if(industryVerdict==='outside'){
   // The company's own page contradicts the campaign's configured industries. That is a conflict,
   // not a question evidence can settle, and it is never widened away.
   conflicts.push(`The company publishes industry "${published.slice(0,80)}", which is outside this campaign's configured industries.`);
  }else{
   reused.push(`The company publishes industry "${published.slice(0,80)}". This campaign configures no industry restriction, so it cannot settle the provider's classification warning; fit stays provisional while research proceeds.`);
  }
 }
 const classificationStatus=classification.length===0?'none' as const:addressed?'addressed_by_evidence' as const:'provisional' as const;
 const status=mismatch&&!conflicts.length?'mismatch':questions.length||conflicts.length?'unresolved':'match';
 const open=mismatch&&!conflicts.length?[]:questions;
 // Answerable by evidence when nothing contradicts the cohort and every open item is a
 // classification question. A conflict or a contradicting attribute is not answerable this way.
 const evidenceCanResolve=status==='unresolved'&&!conflicts.length&&open.length>0&&open.every(q=>classification.includes(q));
 return {status,questions:open,conflicts,reused,classification,evidenceCanResolve,classificationStatus};
}
