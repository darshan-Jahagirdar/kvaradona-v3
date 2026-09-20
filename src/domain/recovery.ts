import type {Packet} from '../contracts/pipeline';
import {resolveCompanyFacts} from './fact-resolution';
export const recoveryVersion='kvd101' as const;
export function recoveryPlan(p:Packet){
 const reused=[p.evidence.length?'original evidence':null,p.providerObservations?.length?'provider observations':null,p.research?'research':null,p.crmSupplement||p.websiteSupplement?'specialist work':null,p.contact?'contact record':null,p.draft?'draft wording':null].filter((v):v is string=>Boolean(v));
 let stage:NonNullable<Packet['recovery']>['stage']|null=null,reason='complete',missing='No automatic recovery needed.';
 if(['rejected','reject','disqualified','defer','deferred','watch','relationship_handoff','icp_mismatch','service_mismatch'].includes(p.state)){reason='human_decision';missing='Review the existing decision before resuming.';}
 else if(p.state==='review_capacity_deferred'){stage='S09';reason='capacity';missing=p.reviewAllocation?.reason??'Campaign review capacity is filled; explicit diagnostic recovery remains available.';}
 else if(p.state==='research_requested'&&p.recovery){stage=p.recovery.stage;reason=p.recovery.reason;missing='Resume the previously selected dependency after its execution hold is resolved.';}
 else if(p.candidate?.providerCompany&&['company_assessment_pending','company_context_pending'].includes(p.state)&&resolveCompanyFacts(p).status!=='match'){stage='S05';reason='eligibility';missing=resolveCompanyFacts(p).status==='mismatch'?'Apply current target to saved attributes; no paid exact-count lookup.':'Resolve decision-changing ICP fields from saved observations first.';}
 else if(['company_context_pending','source_pending','identity_conflict','weak_context','procurement_pending'].includes(p.state)||!p.evidence.length){stage='S04';reason='context';missing='Collect attributable context for the missing question; retain failed source history.';}
 else if(!p.research){stage='S06';reason='research';missing='Interpret saved original context.';}
 else if(['website_pending','specialist_exception','specialist_repairing'].includes(p.state)){stage='S08';reason='specialist';missing='Resume saved specialist work or defer an optional unavailable audit.';}
 else if(!p.packetReview?.acceptable||p.state==='evidence_exception'){stage='S09';reason='claims';missing='Resolve material claim issues using saved evidence and bounded convergent repair.';}
 else if(p.contact?.state!=='resolved'&&p.state==='contact_pending'){stage='S10';reason='contact';missing='Reuse saved candidate search; verify employer, buyer role and work email before resolving.';}
 else if(!p.draft||!p.draftReview?.acceptable||['draft_exception','draft_writing_review','review_required'].includes(p.state)){stage='S11';reason='draft';missing='Check preserved wording against current research and recipient.';}
 const retryUrls=stage==='S04'?(p.contextAttempts??[]).filter(a=>a.stage==='robots'&&['robots_disallowed','robots_invalid_format'].includes(a.code)).map(a=>a.url):[];
 return {version:recoveryVersion,stage,reason,missing,reused,retryUrls:[...new Set(retryUrls)],automatic:Boolean(stage),requiresExecutionGrant:Boolean(stage)};
}
export function packetReadiness(p:Packet){
 return {coverage:p.contextSearch?.coverage??(p.evidence.some(e=>e.origin==='original')?'saved original context':'unavailable'),relevance:p.research?.decision??'unassessed',demand:p.research?.demand??'unknown',contact:p.contact?.state??'not assessed',next:recoveryPlan(p).missing};
}
