import type {Packet,Evidence} from '../contracts/pipeline';
import type {ProviderCompany} from '../contracts/discovery';
import {topicResearchPlan,topicRelevance} from './intent-topics';
import {boilerplatePage,productCataloguePage} from './policy';

export function relatedCompanyContext(e:Evidence,c:ProviderCompany){
 return topicRelevance(e.title+' '+e.text,c)>0;
}
const coverageInstruction={
 unavailable:'No original company page was retrieved. State that plainly; retrieval failure is not a commercial rejection and no need may be inferred either way.',
 boilerplate_only:'Only legal or consent boilerplate was retrieved. It describes none of the company\'s work, so treat research as not yet done rather than reading need into it.',
 general:'Only general company material is available. Keep service need tentative; absence of public details is not a commercial rejection.',
 audience_journey:'The retrieved material describes what this company sells and the journey its own audience takes. Use it to understand that audience. Its keywords, coursework or project wording and publication date do not establish an internal initiative or demand for outside help; do not present it as one.',
 relevant:'Topic mentions, page paths, hiring and provider scores do not themselves establish an active project, pain or external-services demand. Assess dated facts and contrary evidence before proposing a service hypothesis.',
} as const;
// These are retrieval limitations, never a verdict that a company does or does not need help.
export function companyResearchContext(p:Packet){
 const company=p.candidate?.providerCompany;if(!company)return {};
 const coverage=contextAdequacy(p).coverage;
 const currentIntent=company.intent.status==='provider_reported'&&company.intent.topics?.some(t=>t.sourceDate&&Date.parse(t.sourceDate)<=Date.now()&&Date.parse(t.sourceDate)>=Date.now()-14*86400000);
 return {providerPriority:currentIntent?'recent reported topic research':'historical or undated provider context; original research remains eligible',providerObservations:p.providerObservations??[],contextSearch:p.contextSearch,factResolution:p.factResolution,procurementContext:p.procurementContext,technologyQuestion:p.researchRequest?.question&&/technolog|installed|stack|integration/i.test(p.researchRequest.question)?p.researchRequest.question:null,topicResearch:topicResearchPlan(company),evidenceLimitations:{coverage,needAssessment:'unconfirmed_until_original_evidence_review',instruction:coverageInstruction[coverage]}};
}

/** A keyword on a generic landing page is not a reason to abandon alternate retrieval. */
export function contextAdequacy(p:Packet){
 const c=p.candidate?.providerCompany,original=p.evidence.filter(e=>e.origin==='original'&&e.accountHost===c?.domain);
 // Legal boilerplate identifies the company and describes nothing it does, so it never counts as research.
 const substantive=original.filter(e=>!boilerplatePage(e.finalUrl,e.title));
 const topical=substantive.filter(e=>c&&relatedCompanyContext(e,c));
 // What a company sells explains its audience and journey. Coursework and catalogue wording is not its own initiative.
 const initiative=topical.some(e=>!productCataloguePage(e.finalUrl,e.title)&&(/\b(announc|launch|migrat|implement|project|responsibilit|request for proposal|tender|rollout)/i.test(e.text))&&(Boolean(e.publishedAt)||e.attribution?.sourceType==='job'||e.attribution?.sourceType==='procurement'));
 const coverage=!original.length?'unavailable' as const:!substantive.length?'boilerplate_only' as const:initiative?'relevant' as const:topical.length?'audience_journey' as const:'general' as const;
 return {coverage,adequate:initiative};
}
