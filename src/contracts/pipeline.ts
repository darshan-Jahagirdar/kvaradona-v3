import { z } from 'zod';
import {WebsiteSupplement,WebsiteProfile} from './website';
import {ProcurementNotice,ProcurementDetails,ProcurementDocuments} from './procurement';
import {ProviderJob,ProviderCompany} from './discovery';
export const StructuredReference=z.object({sourceId:z.string(),pointers:z.array(z.string()).min(1).max(2)});
export const Evidence = z.object({
  id: z.string().uuid(), url: z.string().url(), finalUrl: z.string().url(), title: z.string(),
  text: z.string().max(24000), contentHash: z.string(), retrievedAt: z.string().datetime(),
  publishedAt: z.string().nullable(), source: z.string(), origin: z.enum(['original','provider_reported']),
  status: z.enum(['current','closed','unknown']), accountHost: z.string().nullable(),
  derivedFromEvidenceId:z.string().uuid().optional(),
  structuredSources:z.array(z.object({id:z.string(),sourceUrl:z.string().url(),scriptIndex:z.number().int().nonnegative(),rawJson:z.string().max(24000),contentHash:z.string()})).max(8).optional(),
  companyFacts:z.array(z.object({id:z.string().uuid().optional(),field:z.enum(['employees','employeeRange','country','industry','name','alternateName']),value:z.union([z.string(),z.number()]),quote:z.string().optional(),statement:z.string().optional(),sourceRef:StructuredReference.optional()})).max(12).optional(),
  attribution: z.object({publisherHost:z.string(),issuerName:z.string().nullable(),issuerHost:z.string().nullable(),basis:z.enum(['owned_host','structured_employer','structured_issuer','explicit_issuer_link','unresolved']),sourceType:z.enum(['company_page','job','announcement','procurement','third_party']),quote:z.string(),sourceRef:StructuredReference.optional(),linkSource:z.object({html:z.string().max(4000),href:z.string(),label:z.string()}).optional()}).optional(),
});
export const ProviderObservation=z.object({id:z.string().uuid(),provider:z.enum(['explorium','apollo']),companyId:z.string(),companyHost:z.string(),field:z.enum(['intent','employees','employeeRange','country','industry','companyName']),value:z.union([z.string(),z.number()]),topic:z.string().optional(),sourceDate:z.string().nullable(),observedAt:z.string().datetime(),operationId:z.string().uuid(),responseHash:z.string(),fieldPath:z.string(),statement:z.string()});
export const RepairRecord=z.object({stage:z.string(),issueHash:z.string(),inputHash:z.string(),outputHash:z.string().optional(),issues:z.array(z.string()),changed:z.boolean().optional()});
export const Claim = z.object({ id: z.string(), text: z.string(), kind: z.enum(['fact','inference','unknown']),
  evidenceId: z.string().uuid(), quote: z.string(), material: z.boolean() });
export const Research = z.object({
  company: z.string(), accountHost: z.string(), identityBasis: z.string(), service: z.string(),
  demand: z.enum(['external_demand','initiative','plausible','weak']),
  whyNow: z.string(), offer: z.string(), buyerRole: z.string(),
  claims: z.array(Claim).max(8), contrary: z.array(z.string()).max(5), uncertainties: z.array(z.string()).max(8),
  decision: z.enum(['priority','exploration','watch','disqualified']), reason: z.string(),
  watchTrigger: z.string().nullable(), specialist: z.enum(['crm','cro','aeo','none']), specialistReason: z.string(),
  followUp: z.object({ query: z.string(), question: z.string(), decisionImpact: z.string() }).nullable(),
});
export const ClaimReview = z.object({ claimId: z.string(), verdict: z.enum(['supported','inference','contradicted','unverifiable']), evidenceIds: z.array(z.string().uuid()), repair: z.string() });
export const Review = z.object({ verdicts: z.array(ClaimReview), acceptable: z.boolean(), issues: z.array(z.string()), inputHash: z.string() });
export const WritingReview=z.object({inputHash:z.string(),acceptable:z.boolean(),relevance:z.enum(['clear','needs_work']),offerClarity:z.enum(['clear','needs_work']),naturalWriting:z.enum(['clear','needs_work']),nextStep:z.enum(['clear','needs_work']),issues:z.array(z.string()).max(5)});
export const Draft = z.object({ subject: z.string().max(200), body: z.string().max(6000), recipient: z.string().email().nullable(), sender: z.string().email().nullable(), claimIds: z.array(z.string()) });
export const ProcurementDraft=Draft.extend({procurement:ProcurementDetails});
export const StoredDraft=Draft.extend({procurement:ProcurementDetails.optional()});
export const CrmAnalysis = z.object({
 findings:z.array(z.object({id:z.string(),observation:z.string(),evidenceId:z.string().uuid(),quote:z.string(),
  hypothesis:z.string(),question:z.string(),deliverable:z.string()})).max(2),
 limitations:z.array(z.string()).max(5),
});
export const CrmReview=Review.extend({verdicts:z.array(ClaimReview.extend({verdict:z.enum(['supported','contradicted','unverifiable'])}))});
export const Contact = z.object({ name: z.string().nullable(), role: z.string(), email: z.string().email().nullable(),
  candidates:z.array(z.object({providerId:z.string(),displayName:z.string(),role:z.string(),company:z.string(),refreshedAt:z.string().nullable(),emailAvailable:z.boolean(),reason:z.string(),
   // The accepted role criteria of the search step that found this person. Selection and enrichment
   // verification both use it, so an alternative search cannot be judged by the first one's wording.
   criteria:z.array(z.string()).max(16).optional(),
   // Each unmet requirement is named separately, so "not reachable" never hides WHY.
   limitations:z.array(z.enum(['employer_unconfirmed','role_not_relevant','below_buyer_seniority','provider_data_stale','no_provider_email','outside_discovery_persona','enrichment_unverified'])).max(7).optional()})).max(5).optional(),
  emailStatus: z.enum(['provider_verified','catch_all','invalid','unknown']), employmentEvidence: z.string().nullable(),
  source: z.string(), observedAt: z.string().datetime(), state: z.enum(['resolved','contact_pending','relationship_handoff']), reason: z.string() });
export const Candidate = z.object({url:z.string().url(),title:z.string(),description:z.string(),source:z.string(),eventKey:z.string(),country:z.string(),searchCountry:z.string().optional(),language:z.string(),discoveredAt:z.string().datetime(),providerRecord:ProviderJob.optional(),providerCompany:ProviderCompany.optional(),procurementNotice:ProcurementNotice.optional()});
export const Packet = z.object({
  candidate: Candidate.optional(),
  reviewAllocation:z.object({cohortId:z.string(),policyShare:z.number().min(0).max(1),capacity:z.number().int().positive(),explorationLimit:z.number().int().nonnegative(),decision:z.enum(['admitted','deferred','diagnostic']),reason:z.string()}).optional(),
  contactSearchRequest:z.object({requestId:z.string().uuid(),reason:z.string().min(20).max(3000),requestedAt:z.string(),completedAt:z.string().optional()}).optional(),
  preserveDraftWording:z.boolean().optional(),
  contractVersion:z.literal('kvd101').optional(),
  /** A person explicitly accepted this account into a named cohort. Records that decision so eligibility
   *  routing can proceed; it is NOT provider verification and never supplies a missing attribute value. */
  eligibility:z.object({basis:z.literal('user_accepted_cohort'),cohort:z.string().min(1).max(120),acceptedNote:z.string().min(10).max(600),
   employeeRange:z.object({min:z.number().int().nonnegative(),max:z.number().int().positive().optional()}).optional(),
   countries:z.array(z.string()).max(30).optional()}).optional(),
  providerObservations:z.array(ProviderObservation).max(80).optional(),
  contextSearch:z.object({version:z.literal('kvd101'),question:z.string(),queries:z.array(z.string()),stop:z.enum(['adequate','exhausted','execution_hold']),coverage:z.enum(['unavailable','boilerplate_only','general','audience_journey','relevant'])}).optional(),
  factResolution:z.object({status:z.enum(['match','mismatch','unresolved']),questions:z.array(z.string()),conflicts:z.array(z.string()),reused:z.array(z.string()),classification:z.array(z.string()).optional(),evidenceCanResolve:z.boolean().optional(),
   // Whether a historical classification warning has actually been reassessed against acquired
   // original evidence. `provisional` is NOT resolved and is never reported as such.
   classificationStatus:z.enum(['none','provisional','addressed_by_evidence']).optional()}).optional(),
  recovery:z.object({version:z.literal('kvd101'),reason:z.string(),stage:z.enum(['S04','S05','S06','S08','S09','S10','S11']),requestedAt:z.string(),retryUrls:z.array(z.string()).optional(),
   // The selected run this recovery belongs to, so a reviewer action inside a run keeps that run's
   // membership, persona policy and finite authority instead of falling back to campaign defaults.
   selectedRun:z.string().uuid().nullable().optional(),origin:z.string().max(40).optional()}).optional(),
  repairs:z.array(RepairRecord).max(12).optional(),
  procurementContext:z.array(z.object({notice:ProcurementNotice,evidenceIds:z.array(z.string().uuid()),basis:z.string(),scope:z.string(),holds:z.array(z.string())})).max(5).optional(),
  contextAttempts:z.array(z.object({url:z.string().url(),stage:z.enum(['robots','page','attribution']),code:z.string().regex(/^[a-z0-9_]{1,80}$/i),status:z.number().int().optional()})).max(12).optional(),
  draftReplacement:z.object({operationId:z.string().uuid(),model:z.literal('gpt-5.6-terra'),reason:z.string().min(20).max(1000),requestedAt:z.string()}).optional(),
  draftCheckRequest:z.object({requestedAt:z.string(),reviewerId:z.string().uuid()}).optional(),
  researchRequest:z.object({question:z.string().max(3000),requestedAt:z.string(),reviewerId:z.string().uuid()}).optional(),
  evidence: z.array(Evidence), research: Research.optional(), packetReview: Review.optional(), draftReview: Review.optional(), writingReview:WritingReview.optional(),
  crmSupplement:z.object({inputHash:z.string(),analysis:CrmAnalysis,review:Review.optional()}).optional(),
  websiteSupplement:WebsiteSupplement.optional(),
  deferredWebsite:WebsiteSupplement.optional(),
  researchRepairAttempts:z.number().int().min(0).max(2).optional(),
  specialistRepairAttempts:z.number().int().min(0).max(1).optional(),
  // Durable logical-attempt counter for drafting. It changes the operation key so a rejected
  // COMPLETED output is regenerated instead of replayed. It never applies to a dispatched or
  // ambiguous operation, whose outcome stays held.
  draftAttempt:z.number().int().min(0).max(2).optional(),
  // The exact output a check rejected, preserved as evidence and as input for the next attempt.
  rejectedDraft:z.object({draft:z.unknown(),reason:z.string(),citableClaimIds:z.string(),at:z.string()}).optional(),
  // The bounded contact search plan: the initial search plus at most two justified alternatives for
  // the same company and service. Persisted so a resume reuses settled work instead of re-searching.
  // A supported change of company domain, with the evidence that established it. Recorded so the
  // same identity is used by attribution, contact lookup and deduplication rather than re-derived.
  identityResolution:z.object({from:z.string(),to:z.string(),
   basis:z.literal('first_party_redirect_with_structured_identity'),
   evidenceId:z.string(),requestedUrl:z.string(),finalUrl:z.string(),at:z.string()}).optional(),
  // A reviewer's answer to an identity question. It is a HINT: it is verified against the company's
  // own published identity before anything is attributed to it, and never certified by being typed.
  identityHint:z.object({name:z.string().min(1).max(200),domain:z.string().max(253).nullable(),
   note:z.string().max(3000),reviewerId:z.string().uuid(),at:z.string(),
   status:z.enum(['unverified','verified','refuted']).default('unverified')}).optional(),
  // Capture material that failed company attribution. Kept as recovery material with its reason,
  // separate from citable evidence, instead of being discarded.
  rejectedCaptures:z.array(z.object({url:z.string().url(),finalUrl:z.string().url(),title:z.string().max(300),
   contentHash:z.string(),retrievedAt:z.string(),reason:z.string().max(200)})).max(8).optional(),
  // Why a company is waiting, what was already tried, and whether another round can change it.
  pendingResolution:z.object({reason:z.enum(['identity_unresolved','domain_changed','classification_conflict','no_usable_evidence','contact_unreachable']),
   detail:z.string().max(600),attempts:z.number().int().min(0).max(3),
   nextAction:z.enum(['retry_resolution','ask_reviewer','stop']),question:z.string().max(300).optional(),at:z.string()}).optional(),
  // The authoritative persisted plan for this account's contact work: the exact request it is bound
  // to, its steps, its reveal counter and what each attempt produced. A resume follows this plan;
  // a changed host, role or service starts a new one instead of reusing a different question.
  contactPlan:z.object({
   host:z.string().max(253).optional(),role:z.string().max(300).optional(),service:z.string().max(300).optional(),
   steps:z.array(z.object({key:z.string(),titles:z.array(z.string()).max(8)})).max(3).optional(),
   reveals:z.number().int().min(0).max(10).optional(),
   // Candidate found and contact resolved are different facts and are recorded separately.
   resolvedContact:z.boolean().optional(),
   attempts:z.array(z.object({key:z.string(),titles:z.array(z.string()).max(8),
   reason:z.string(),at:z.string(),returned:z.number().int().nonnegative(),
   outcome:z.enum(['no_results','no_relevant_candidate','no_reachable_candidate','candidate_found','resolved','blocked'])})).max(3)}).optional(),
  // What the current draft was written from, so materially improved findings produce a new version.
  draftBasis:z.string().optional(),
  deferredCrm:z.object({inputHash:z.string(),analysis:CrmAnalysis,review:Review.optional()}).optional(),
  websiteFailure:z.object({inputHash:z.string(),reason:z.enum(['navigation_timeout','capture_unavailable']),at:z.string()}).optional(),
  websiteRequest:z.object({profiles:z.array(WebsiteProfile).min(1).max(2),url:z.string().url(),question:z.string(),requestedAt:z.string(),verificationOnly:z.boolean().default(false)}).optional(),
  // One automatic journey follow-up, recorded so it happens once and stays auditable.
  websiteJourney:z.object({url:z.string().url(),label:z.string(),from:z.string(),at:z.string()}).optional(),
  // The page the current analysis actually sees, tied to the research inputs that chose it.
  websiteTarget:z.object({url:z.string().url(),inputHash:z.string()}).optional(),
  procurementDocuments:ProcurementDocuments.optional(), contact: Contact.optional(), draft: StoredDraft.optional(), state: z.string(),
  relationship: z.enum(['unknown','clear','handoff','suppressed']).default('unknown'),
  notes: z.array(z.string()).default([]), specialistFindings: z.array(z.object({ profile: z.enum(['crm','cro','aeo']), metric: z.string(), observation: z.string(), hypothesis: z.string() })).default([]),
  mode: z.enum(['live','fixture']),
});
export const Job = z.object({
  id: z.string().uuid(), organization_id: z.string().uuid(), campaign_id: z.string().uuid(), opportunity_id: z.string().uuid().nullable(),
  stage: z.string(), business_key: z.string(), input_hash: z.string(), input_version: z.number().int(), schema_version: z.string(), prompt_version: z.string(),
  attempt_token: z.string().uuid(), attempts: z.number(), payload: z.unknown(),
  // Set when this job belongs to a selected run; null for discovery and historical work.
  run_id: z.string().uuid().nullable().optional(),
});
export type Packet = z.infer<typeof Packet>;
export type Evidence = z.infer<typeof Evidence>;
export type Research = z.infer<typeof Research>;
export type Claim = z.infer<typeof Claim>;
export type Review = z.infer<typeof Review>;
export type Draft = z.infer<typeof Draft>;
export type Contact = z.infer<typeof Contact>;
export type Job = z.infer<typeof Job>;
