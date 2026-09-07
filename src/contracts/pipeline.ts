import { z } from 'zod';
import {WebsiteSupplement,WebsiteProfile} from './website';
import {ProcurementNotice,ProcurementDetails,ProcurementDocuments} from './procurement';
import {ProviderJob} from './discovery';
export const Evidence = z.object({
  id: z.string().uuid(), url: z.string().url(), finalUrl: z.string().url(), title: z.string(),
  text: z.string().max(24000), contentHash: z.string(), retrievedAt: z.string().datetime(),
  publishedAt: z.string().nullable(), source: z.string(), origin: z.enum(['original','provider_reported']),
  status: z.enum(['current','closed','unknown']), accountHost: z.string().nullable(),
});
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
  candidates:z.array(z.object({providerId:z.string(),displayName:z.string(),role:z.string(),company:z.string(),refreshedAt:z.string().nullable(),emailAvailable:z.boolean(),reason:z.string()})).max(5).optional(),
  emailStatus: z.enum(['provider_verified','catch_all','invalid','unknown']), employmentEvidence: z.string().nullable(),
  source: z.string(), observedAt: z.string().datetime(), state: z.enum(['resolved','contact_pending','relationship_handoff']), reason: z.string() });
export const Candidate = z.object({url:z.string().url(),title:z.string(),description:z.string(),source:z.string(),eventKey:z.string(),country:z.string(),searchCountry:z.string().optional(),language:z.string(),discoveredAt:z.string().datetime(),providerRecord:ProviderJob.optional(),procurementNotice:ProcurementNotice.optional()});
export const Packet = z.object({
  candidate: Candidate.optional(),
  draftReplacement:z.object({operationId:z.string().uuid(),model:z.literal('gpt-5.6-terra'),reason:z.string().min(20).max(1000),requestedAt:z.string()}).optional(),
  draftCheckRequest:z.object({requestedAt:z.string(),reviewerId:z.string().uuid()}).optional(),
  researchRequest:z.object({question:z.string().max(3000),requestedAt:z.string(),reviewerId:z.string().uuid()}).optional(),
  evidence: z.array(Evidence), research: Research.optional(), packetReview: Review.optional(), draftReview: Review.optional(), writingReview:WritingReview.optional(),
  crmSupplement:z.object({inputHash:z.string(),analysis:CrmAnalysis,review:Review.optional()}).optional(),
  websiteSupplement:WebsiteSupplement.optional(),
  websiteFailure:z.object({inputHash:z.string(),reason:z.enum(['navigation_timeout','capture_unavailable']),at:z.string()}).optional(),
  websiteRequest:z.object({profiles:z.array(WebsiteProfile).min(1).max(2),url:z.string().url(),question:z.string(),requestedAt:z.string(),verificationOnly:z.boolean().default(false)}).optional(),
  procurementDocuments:ProcurementDocuments.optional(), contact: Contact.optional(), draft: StoredDraft.optional(), state: z.string(),
  relationship: z.enum(['unknown','clear','handoff','suppressed']).default('unknown'),
  notes: z.array(z.string()).default([]), specialistFindings: z.array(z.object({ profile: z.enum(['crm','cro','aeo']), metric: z.string(), observation: z.string(), hypothesis: z.string() })).default([]),
  mode: z.enum(['live','fixture']),
});
export const Job = z.object({
  id: z.string().uuid(), organization_id: z.string().uuid(), campaign_id: z.string().uuid(), opportunity_id: z.string().uuid().nullable(),
  stage: z.string(), business_key: z.string(), input_hash: z.string(), input_version: z.number().int(), schema_version: z.string(), prompt_version: z.string(),
  attempt_token: z.string().uuid(), attempts: z.number(), payload: z.unknown(),
});
export type Packet = z.infer<typeof Packet>;
export type Evidence = z.infer<typeof Evidence>;
export type Research = z.infer<typeof Research>;
export type Claim = z.infer<typeof Claim>;
export type Review = z.infer<typeof Review>;
export type Draft = z.infer<typeof Draft>;
export type Contact = z.infer<typeof Contact>;
export type Job = z.infer<typeof Job>;
