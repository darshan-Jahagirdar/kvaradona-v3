import type {Packet,Research} from '../contracts/pipeline';
import {hash,reviewProblems,validateResearch,sourceQuote} from './policy';
import {websiteDraftClaims} from './website-specialist';

export function crmInputHash(p:Packet){
 return hash({research:p.research,evidence:p.evidence.filter(e=>e.source!=='website_capture').map(e=>({id:e.id,version:hash(e)}))});
}
export function crmContext(p:Packet){
 if(!p.research)throw Error('research_missing');
 const r=p.research;
 // Original dated source excerpts only; neither contact data nor an earlier draft is needed.
 const seen=new Set<string>();
 const evidence=p.evidence.filter(e=>e.source!=='website_capture'&&e.origin==='original'&&e.accountHost===r.accountHost)
  .sort((a,b)=>b.retrievedAt.localeCompare(a.retrievedAt)).filter(e=>{if(seen.has(e.finalUrl))return false;seen.add(e.finalUrl);return true;}).slice(0,2)
  .map(e=>{
   const excerpts=[e.text.slice(0,1800)];
   for(const c of r.claims.filter(c=>c.evidenceId===e.id&&c.quote)){
    const at=e.text.indexOf(c.quote);if(at>=0&&!excerpts.some(s=>s.includes(c.quote)))excerpts.push(e.text.slice(Math.max(0,at-150),at+c.quote.length+150));
   }
   return {id:e.id,url:e.finalUrl,title:e.title,publishedAt:e.publishedAt,retrievedAt:e.retrievedAt,status:e.status,text:excerpts.join('\n[Source excerpt]\n')};
  });
 return {company:r.company,service:r.service,question:`Assess ${r.service} using original evidence. Provider topic rankings and research routing are not original-source findings.`,contrary:r.contrary,uncertainties:r.uncertainties,evidence};
}
export function crmReviewTarget(p:Packet){return JSON.stringify({inputHash:p.crmSupplement?.inputHash,analysis:p.crmSupplement?.analysis});}
export function repairCrmCitations(p:Packet){
 if(!p.crmSupplement)return;
 p.crmSupplement.analysis.findings=p.crmSupplement.analysis.findings.map(f=>{
  const e=p.evidence.find(e=>e.id===f.evidenceId),quote=e?sourceQuote(f.quote,e.text):null;
  const condition='If the buyer confirms a need for outside support: ';
  const deliverable=f.deliverable.startsWith(condition)?f.deliverable:condition+f.deliverable;
  return {...f,quote:quote??f.quote,deliverable};
 });
}
function crmClaims(p:Packet):Research{
 if(!p.research||!p.crmSupplement)throw Error('crm_analysis_missing');
 return {...p.research,claims:p.crmSupplement.analysis.findings.map(f=>({id:f.id,text:f.observation,kind:'fact' as const,evidenceId:f.evidenceId,quote:f.quote,material:true}))};
}
// The packet review checks all research; draft coverage applies to the claims used in that message.
export function draftResearch(p:Packet,available=false):Research{
 if(!p.research)throw Error('research_missing');
 const extra=p.crmSupplement?crmClaims(p).claims.filter(c=>available||p.draft?.claimIds.includes(c.id)):[];
 const base=available||!p.draft?p.research.claims:p.research.claims.filter(c=>p.draft!.claimIds.includes(c.id));
 return {...p.research,claims:[...base,...extra,...websiteDraftClaims(p,available)]};
}
export function crmAnalysisProblems(p:Packet):string[]{
 if(!p.crmSupplement)return ['CRM analysis missing'];
 if(!p.research)return ['CRM research missing'];
 const errors:string[]=[];
 if(p.research?.specialist!=='crm'||p.crmSupplement.inputHash!==crmInputHash(p))errors.push('CRM analysis does not match current research and evidence');
 const r=crmClaims(p);
 if(r.claims.some(c=>!/^crm[-_a-z0-9]+$/i.test(c.id)||p.research?.claims.some(base=>base.id===c.id)))errors.push('CRM claim IDs must be unique and crm-prefixed');
 if(r.claims.length)errors.push(...validateResearch(r,p));
 for(const c of r.claims){const e=p.evidence.find(e=>e.id===c.evidenceId);if(e?.origin!=='original'||e.accountHost!==r.accountHost)errors.push(`CRM source attribution:${c.id}`);}
 return errors;
}
export function crmReviewProblems(p:Packet):string[]{
 const errors=crmAnalysisProblems(p),review=p.crmSupplement?.review;
 if(!p.research||!p.crmSupplement)return errors;
 if(!review)return [...errors,'CRM review required'];
 if(review.issues.length)errors.push(...review.issues);
 // Zero findings still needs a review of the limitations and explicit empty coverage.
 const r=crmClaims(p);
 if(r.claims.length)errors.push(...reviewProblems(review,r,p,crmReviewTarget(p)));
 else if(review.inputHash!==hash(crmReviewTarget(p))||!review.acceptable||review.verdicts.length)errors.push('CRM zero-finding review invalid');
 if(review.verdicts.some(v=>!r.claims.some(c=>c.id===v.claimId)))errors.push('Unexpected CRM review claim');
 return errors;
}
