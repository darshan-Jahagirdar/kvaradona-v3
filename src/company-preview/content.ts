import { z } from 'zod';

/**
 * Reviewed company research, supplied as a private payload rather than stored as workflow records.
 *
 * This is deliberately NOT a workflow `Packet`. These packages were researched outside the
 * automated pipeline, so they must never enter opportunity revisions, queues, provider accounting
 * or run metrics. The schema is strict: anything unexpected fails closed instead of rendering.
 */

const Id = z.string().regex(/^[a-z0-9-]{1,40}$/);
const Text = z.string().trim().min(1).max(4000);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PublicUrl = z.string().url().max(500).refine(u => u.startsWith('https://'), 'https only');
const Email = z.string().email().max(254);

/** How each source was checked. Unknown methods are rejected rather than shown without a label. */
export const sourceBasisLabels = {
  direct_http: 'Direct HTTP check',
  recorded_browser_observation: 'Browser observation',
  saved_official_page: 'Official page, saved research',
  saved_capture_and_browser_review: 'Saved capture and browser review',
  provider_record: 'Contact-data provider record',
  indexed_official_page: 'Official page via web index',
} as const;
const SourceBasis = z.enum(Object.keys(sourceBasisLabels) as [keyof typeof sourceBasisLabels, ...(keyof typeof sourceBasisLabels)[]]);

const Source = z.object({
  id: Id, title: Text, url: PublicUrl.nullable(), checkedOn: Day, basis: SourceBasis, note: Text,
}).strict();

const EmailStatus = z.enum(['unresolved', 'officially_published', 'provider_verified']);

const Company = z.object({
  id: Id, name: Text, domain: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/), summary: Text,
  services: z.array(Text).min(1).max(6), researchStatus: Text, contactStatus: Text,
  facts: z.array(z.object({ id: Id, text: Text, sourceIds: z.array(Id).min(1).max(8) }).strict()).min(1).max(8),
  inferences: z.array(z.object({ id: Id, text: Text, factIds: z.array(Id).min(1).max(8) }).strict()).min(1).max(6),
  painPoints: z.array(z.object({
    id: Id, title: Text, description: Text, status: z.enum(['observed', 'potential']),
    factIds: z.array(Id).min(1).max(6),
  }).strict()).length(3),
  offer: z.object({ title: Text, description: Text, deliverable: Text, validation: Text }).strict(),
  contact: z.object({
    name: Text, title: Text, email: Email.nullable(), emailStatus: EmailStatus, emailStatusLabel: Text,
    roleSourceIds: z.array(Id).max(4), emailSourceIds: z.array(Id).max(4),
    linkedin: PublicUrl.nullable(), fit: Text,
  }).strict(),
  draft: z.object({ subject: z.string().trim().min(1).max(200), body: z.string().min(1).max(4000), recipientEmail: Email.nullable(), status: Text }).strict(),
  limitations: z.array(Text).min(1).max(8),
  sources: z.array(Source).min(1).max(12),
}).strict();

export const CompanyPreviewContent = z.object({
  schemaVersion: z.literal(1),
  contentVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d+$/),
  reviewedOn: Day,
  title: Text, subtitle: Text,
  intentContext: z.object({
    topic: Text, basis: Text, signalDate: Day.nullable(), originatingUnit: Text.nullable(), note: Text,
  }).strict(),
  ui: z.object({
    painPointLabels: z.object({ observed: Text, potential: Text }).strict(),
    draftLabel: Text, sendingLabel: Text,
    overviewLabels: z.array(Text).length(3),
    sectionOrder: z.array(Text).min(1).max(12),
  }).strict(),
  companies: z.array(Company).length(4),
  /** Private provenance and accounting. Validated for shape only; never projected to the browser. */
  internal: z.record(z.string(), z.unknown()),
}).strict();
export type CompanyPreviewContent = z.infer<typeof CompanyPreviewContent>;

/** Every reference must point at something that exists, and contact/draft statuses must agree. */
export function contentProblems(content: CompanyPreviewContent): string[] {
  const problems: string[] = [];
  const companyIds = new Set<string>();
  for (const c of content.companies) {
    if (companyIds.has(c.id)) problems.push(`${c.id}: duplicate company id`);
    companyIds.add(c.id);
    const sources = new Set(c.sources.map(s => s.id)), facts = new Set(c.facts.map(f => f.id));
    const unique = (ids: string[], what: string) => { if (new Set(ids).size !== ids.length) problems.push(`${c.id}: duplicate ${what} id`); };
    unique(c.sources.map(s => s.id), 'source'); unique(c.facts.map(f => f.id), 'fact');
    unique(c.inferences.map(i => i.id), 'inference'); unique(c.painPoints.map(p => p.id), 'pain point');
    for (const f of c.facts) for (const s of f.sourceIds) if (!sources.has(s)) problems.push(`${c.id}: fact ${f.id} cites unknown source ${s}`);
    for (const i of c.inferences) for (const f of i.factIds) if (!facts.has(f)) problems.push(`${c.id}: inference ${i.id} cites unknown fact ${f}`);
    for (const p of c.painPoints) for (const f of p.factIds) if (!facts.has(f)) problems.push(`${c.id}: pain point ${p.id} cites unknown fact ${f}`);
    for (const s of [...c.contact.roleSourceIds, ...c.contact.emailSourceIds]) if (!sources.has(s)) problems.push(`${c.id}: contact cites unknown source ${s}`);
    // An unresolved address stays unresolved everywhere: no email, no recipient, no email source.
    if (c.contact.emailStatus === 'unresolved') {
      if (c.contact.email !== null) problems.push(`${c.id}: unresolved contact carries an email`);
      if (c.contact.emailSourceIds.length) problems.push(`${c.id}: unresolved contact cites an email source`);
    } else {
      if (c.contact.email === null) problems.push(`${c.id}: ${c.contact.emailStatus} contact has no email`);
      if (!c.contact.emailSourceIds.length) problems.push(`${c.id}: email has no supporting source`);
    }
    if (c.draft.recipientEmail !== c.contact.email) problems.push(`${c.id}: draft recipient does not match the contact email`);
  }
  return problems;
}

export type ParseResult = { ok: true; content: CompanyPreviewContent } | { ok: false; reason: 'missing' | 'malformed' | 'invalid' };

/** Parse and validate the raw payload. Fails closed; the reason never includes payload content. */
export function parseCompanyPreview(raw: string | undefined): ParseResult {
  if (!raw || !raw.trim()) return { ok: false, reason: 'missing' };
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return { ok: false, reason: 'malformed' }; }
  const parsed = CompanyPreviewContent.safeParse(json);
  if (!parsed.success || contentProblems(parsed.data).length) return { ok: false, reason: 'invalid' };
  return { ok: true, content: parsed.data };
}

type SourceLink = { title: string; url: string | null };
export interface DisplayCompany {
  id: string; name: string; domain: string; summary: string; services: string[];
  researchStatus: string; contactStatus: string;
  painPoints: { id: string; title: string; description: string; status: 'observed' | 'potential'; label: string }[];
  facts: { id: string; text: string; sources: SourceLink[] }[];
  inferences: { id: string; text: string }[];
  offer: { title: string; description: string; deliverable: string; validation: string };
  contact: {
    name: string; title: string; email: string | null; emailStatus: z.infer<typeof EmailStatus>;
    emailStatusLabel: string; linkedin: string | null; fit: string; roleSources: SourceLink[]; emailSources: SourceLink[];
  };
  draft: { subject: string; body: string; recipientEmail: string | null; status: string };
  limitations: string[];
  sources: { id: string; title: string; url: string | null; checkedOn: string; basisLabel: string; note: string }[];
}
export interface DisplayContent {
  contentVersion: string; reviewedOn: string; title: string; subtitle: string;
  intent: { topic: string; basis: string; note: string; signalDate: string | null; originatingUnit: string | null };
  labels: { observed: string; potential: string; draft: string; sending: string; overview: string[] };
  sectionOrder: string[];
  counts: { companies: number; workEmails: number; drafts: number; draftsWithoutRecipient: number };
  companies: DisplayCompany[];
}

/**
 * The only shape that may leave the server. Built field by field from an allow-list, so the
 * payload's `internal` provenance, accounting and any future private field can never reach the
 * browser by being spread through.
 */
export function toDisplay(content: CompanyPreviewContent): DisplayContent {
  const companies = content.companies.map((c): DisplayCompany => {
    const byId = new Map(c.sources.map(s => [s.id, s]));
    const links = (ids: string[]) => ids.map(id => byId.get(id)!).map(s => ({ title: s.title, url: s.url }));
    return {
      id: c.id, name: c.name, domain: c.domain, summary: c.summary, services: [...c.services],
      researchStatus: c.researchStatus, contactStatus: c.contactStatus,
      painPoints: c.painPoints.map(p => ({
        id: p.id, title: p.title, description: p.description, status: p.status,
        label: p.status === 'observed' ? content.ui.painPointLabels.observed : content.ui.painPointLabels.potential,
      })),
      facts: c.facts.map(f => ({ id: f.id, text: f.text, sources: links(f.sourceIds) })),
      inferences: c.inferences.map(i => ({ id: i.id, text: i.text })),
      offer: { title: c.offer.title, description: c.offer.description, deliverable: c.offer.deliverable, validation: c.offer.validation },
      contact: {
        name: c.contact.name, title: c.contact.title, email: c.contact.email, emailStatus: c.contact.emailStatus,
        emailStatusLabel: c.contact.emailStatusLabel, linkedin: c.contact.linkedin, fit: c.contact.fit,
        roleSources: links(c.contact.roleSourceIds), emailSources: links(c.contact.emailSourceIds),
      },
      draft: { subject: c.draft.subject, body: c.draft.body, recipientEmail: c.draft.recipientEmail, status: c.draft.status },
      limitations: [...c.limitations],
      sources: c.sources.map(s => ({ id: s.id, title: s.title, url: s.url, checkedOn: s.checkedOn, basisLabel: sourceBasisLabels[s.basis], note: s.note })),
    };
  });
  return {
    contentVersion: content.contentVersion, reviewedOn: content.reviewedOn, title: content.title, subtitle: content.subtitle,
    intent: {
      topic: content.intentContext.topic, basis: content.intentContext.basis, note: content.intentContext.note,
      signalDate: content.intentContext.signalDate, originatingUnit: content.intentContext.originatingUnit,
    },
    labels: {
      observed: content.ui.painPointLabels.observed, potential: content.ui.painPointLabels.potential,
      draft: content.ui.draftLabel, sending: content.ui.sendingLabel, overview: [...content.ui.overviewLabels],
    },
    sectionOrder: [...content.ui.sectionOrder],
    // Content counts only. They describe what is shown, never workflow completion.
    counts: {
      companies: companies.length,
      workEmails: companies.filter(c => c.contact.email !== null).length,
      drafts: companies.length,
      draftsWithoutRecipient: companies.filter(c => c.draft.recipientEmail === null).length,
    },
    companies,
  };
}
