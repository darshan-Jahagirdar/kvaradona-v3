import {companyResearchContext} from './company-research';
import type {Packet} from '../contracts/pipeline';
import {draftResearch} from './crm-specialist';
// Keep older unattributed source versions as context without paying to repeat their whole body.
// Preserve every cited verbatim excerpt, including any outside the opening text window.
export function draftReviewContext(p:Packet){
 return {...companyResearchContext(p),providerCompany:p.candidate?.providerCompany,evidence:p.evidence.map(e=>{
  const intro=e.text.slice(0,p.candidate?.procurementNotice?1500:e.accountHost?5000:1500),extra:string[]=[];
  for(const c of [...(p.research?draftResearch(p).claims:[]),...(p.draft?.procurement?.requirements??[]),...(p.draft?.procurement?.responseRoute?[p.draft.procurement.responseRoute]:[])])if(c.evidenceId===e.id&&c.quote&&!intro.includes(c.quote)){
   const at=e.text.indexOf(c.quote);if(at>=0)extra.push(e.text.slice(Math.max(0,at-200),Math.min(e.text.length,at+c.quote.length+200)));
  }
  return {...e,text:[intro,...new Set(extra)].join('\n[Additional cited passage]\n')};
 }),specialistFindings:p.specialistFindings,crmAnalysis:p.crmSupplement?.analysis,websiteAnalysis:p.websiteSupplement?.analysis,contact:p.contact?{name:p.contact.name,role:p.contact.role,email:p.contact.email,emailStatus:p.contact.emailStatus,employmentEvidence:p.contact.employmentEvidence,source:p.contact.source,observedAt:p.contact.observedAt}:null};
}
