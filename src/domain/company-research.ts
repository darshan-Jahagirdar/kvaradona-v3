import type {Packet,Evidence} from '../contracts/pipeline';
import type {ProviderCompany} from '../contracts/discovery';
import {topicResearchPlan,topicRelevance} from './intent-topics';

export function relatedCompanyContext(e:Evidence,c:ProviderCompany){
 return topicRelevance(e.title+' '+e.text,c)>0;
}
// These are retrieval limitations, never a verdict that a company does or does not need help.
export function companyResearchContext(p:Packet){
 const company=p.candidate?.providerCompany;if(!company)return {};
 const coverage=!p.evidence.length?'unavailable':p.evidence.some(e=>relatedCompanyContext(e,company))?'topic_related_material':'general_company_only';
 return {topicResearch:topicResearchPlan(company),evidenceLimitations:{coverage,needAssessment:'unconfirmed_until_original_evidence_review',instruction:coverage==='general_company_only'?'Only general company material is available. Keep service need tentative; absence of public details is not a commercial rejection.':'Topic mentions, page paths, hiring and provider scores do not themselves establish an active project, pain or external-services demand. Assess dated facts and contrary evidence before proposing a service hypothesis.'}};
}
