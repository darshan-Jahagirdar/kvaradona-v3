import { createHash } from 'node:crypto';
import { getDomain } from 'tldts';
import type { Packet, Research, Review } from '../contracts/pipeline';
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function hostOf(url: string) { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
export function identity(url: string) { const host = hostOf(url); return { host, registrableDomain: getDomain(host), verifiedAlias: false }; }
export function eventKey(url: string) {
  const u = new URL(url); u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|ref$|source$)/i.test(k)) u.searchParams.delete(k);
  u.searchParams.sort(); return hash(u.toString());
}
const normalized = (s: string) => s.replace(/\s+/g, ' ').trim();
export function validateResearch(research: Research, packet: Packet): string[] {
  const errors: string[] = [];
  if (!research.claims.length) errors.push('No attributable conversation fact');
  const ids = new Set<string>();
  for (const c of research.claims) {
    if(ids.has(c.id)) errors.push(`Duplicate claim:${c.id}`); ids.add(c.id);
    const e = packet.evidence.find(x => x.id === c.evidenceId);
    if (!e || !c.quote.trim() || !normalized(e.text).includes(normalized(c.quote))) errors.push(`Unsupported quotation:${c.id}`);
    if (c.kind === 'fact' && !e?.accountHost) errors.push(`Unresolved source attribution:${c.id}`);
  }
  if (!packet.evidence.some(e => e.accountHost === research.accountHost)) errors.push('Unverified company identity');
  if (research.decision === 'watch' && !research.watchTrigger) errors.push('Watch requires an observable trigger');
  return errors;
}
export function reviewProblems(review: Review, research: Research, packet: Packet, checkedText: string): string[] {
  const errors = [...validateResearch(research, packet)];
  if (review.inputHash !== hash(checkedText)) errors.push('Review does not match exact input');
  if (!review.acceptable) errors.push(...review.issues, 'Reviewer requires repair');
  for (const claim of research.claims.filter(c => c.material)) {
    const verdicts = review.verdicts.filter(v => v.claimId === claim.id);
    if (verdicts.length !== 1) { errors.push(`Review coverage missing:${claim.id}`); continue; }
    const v = verdicts[0];
    if (v.verdict === 'contradicted' || v.verdict === 'unverifiable') errors.push(`Unresolved material claim:${claim.id}`);
    if (claim.kind === 'fact' && v.verdict === 'inference') errors.push(`Fact needs qualification:${claim.id}`);
    if (!v.evidenceIds.includes(claim.evidenceId) || v.evidenceIds.some(id => !packet.evidence.some(e => e.id === id))) errors.push(`Invalid review citation:${claim.id}`);
  }
  return errors;
}
export function contactPending(role: string, reason: string) {
  return { name: null, role, email: null, emailStatus: 'unknown' as const, employmentEvidence: null, source: 'unavailable', observedAt: new Date().toISOString(), state: 'contact_pending' as const, reason };
}
export function isFresh(at: string | null, days: number, now = Date.now()) { return at !== null && Number.isFinite(Date.parse(at)) && Date.parse(at) <= now && now-Date.parse(at)<=days*86400000; }
export function selectObservation(observations: { value: string | null; source: string; at: string }[]) {
  const values = new Set(observations.map(o => o.value).filter(v => v !== null));
  return { value: values.size === 1 ? [...values][0] : null, conflict: values.size > 1, observations };
}
export function enrichmentQuestion(field: string, decisionImpact: string, existing: {at: string; value: unknown} | undefined) {
  return { field, needed: Boolean(decisionImpact.trim()) && (!existing || !isFresh(existing.at,30)), reason: decisionImpact };
}
export const campaignProfile = {
  version: 1, name: 'HubSpot implementation · initial US group', serviceOrder: ['HubSpot','monday.com','Salesforce','Zoho','CRO','AEO'],
  groups: [
    { region: 'US', country: 'US', language: 'en', query: '"HubSpot" "implementation" "request for proposal"' },
    { region: 'Europe', country: 'GB', language: 'en', query: '"HubSpot" "migration" "partner" "tender"' },
    { region: 'Australia', country: 'AU', language: 'en', query: '"HubSpot" "implementation" "operations" hiring' },
    { region: 'Asia', country: 'SG', language: 'en', query: '"HubSpot" "implementation" "operations" hiring' },
  ], groupIndex: 0, sizeBands: [[1,500],[501,10000]], explorationShare: 0.2,
  maxCandidates: 4, maxResearch: 1, maxSearches: 3, maxDocuments: 6, proof: [], sendingEnabled: false,
  offer: 'A scoped review of CRM handoffs, migration or workflow requirements, followed by a practical implementation outline.',
};
