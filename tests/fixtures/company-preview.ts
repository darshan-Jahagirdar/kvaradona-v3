/** Synthetic company-preview payload. Every organization, person and address here is invented. */
type Basis = 'direct_http' | 'provider_record' | 'indexed_official_page';

function company(id: string, name: string, email: string | null, status: 'unresolved' | 'officially_published' | 'provider_verified', observed: boolean) {
  const domain = `${id}.example.org`, basis: Basis = status === 'provider_verified' ? 'provider_record' : 'direct_http';
  return {
    id, name, domain, summary: `${name} is a synthetic test organization.`,
    services: ['Website analytics'], researchStatus: 'Test research', contactStatus: email ? 'Work email available' : 'Work email unresolved',
    facts: [
      { id: `${id}-f1`, text: `${name} publishes a test page.`, sourceIds: [`${id}-s1`] },
      { id: `${id}-f2`, text: `${name} lists a test role.`, sourceIds: [`${id}-s2`] },
    ],
    inferences: [{ id: `${id}-i1`, text: 'A test inference drawn from the first fact.', factIds: [`${id}-f1`] }],
    painPoints: [
      { id: `${id}-p1`, title: 'First test pain point', description: 'Test description.', status: observed ? 'observed' as const : 'potential' as const, factIds: [`${id}-f1`] },
      { id: `${id}-p2`, title: 'Second test pain point', description: 'Test description.', status: 'potential' as const, factIds: [`${id}-f1`] },
      { id: `${id}-p3`, title: 'Third test pain point', description: 'Test description.', status: 'potential' as const, factIds: [`${id}-f2`] },
    ],
    offer: { title: 'Test offer', description: 'Test offer description.', deliverable: 'A test deliverable.', validation: 'A test validation.' },
    contact: {
      name: `Test Person ${id}`, title: 'Test Director', email, emailStatus: status,
      emailStatusLabel: email ? 'Test email status' : 'Work email unresolved',
      roleSourceIds: [`${id}-s2`], emailSourceIds: email ? [`${id}-s2`] : [],
      linkedin: null, fit: 'Test fit.',
    },
    draft: { subject: `Test subject for ${name}`, body: 'Hello,\n\nTest body.\n\n[Your name]', recipientEmail: email, status: 'Draft for review' },
    limitations: ['Test limitation.'],
    sources: [
      { id: `${id}-s1`, title: 'Test page', url: `https://${domain}/page`, checkedOn: '2026-01-02', basis: 'direct_http' as const, note: 'Test note.' },
      { id: `${id}-s2`, title: 'Test directory', url: status === 'provider_verified' ? null : `https://${domain}/people`, checkedOn: '2026-01-02', basis, note: 'Test note.' },
    ],
  };
}

export const INTERNAL_MARKER = 'synthetic-internal-marker-7f3a';

export function syntheticPreview() {
  return {
    schemaVersion: 1, contentVersion: '2026-01-02.1', reviewedOn: '2026-01-02',
    title: 'Test research', subtitle: 'Synthetic packages for tests.',
    intentContext: { topic: 'Test topic', basis: 'Test basis', signalDate: null, originatingUnit: null, note: 'Test note.' },
    ui: {
      painPointLabels: { observed: 'Observed', potential: 'To validate' },
      draftLabel: 'Draft for review', sendingLabel: 'Sending disabled',
      overviewLabels: ['Companies', 'Work email available', 'Drafts prepared'],
      sectionOrder: ['Overview', 'Pain points', 'Facts', 'Inferences', 'Recommended offer', 'Contact', 'Draft for review', 'Sources & open questions'],
    },
    companies: [
      company('alpha', 'Alpha Test Co', null, 'unresolved', true),
      company('beta', 'Beta Test University', 'beta.person@beta.example.org', 'officially_published', true),
      company('gamma', 'Gamma Test Hospital', 'gamma.person@gamma.example.org', 'provider_verified', false),
      company('delta', 'Delta Test College', 'delta.person@delta.example.org', 'officially_published', false),
    ],
    internal: { accounting: { apolloLookups: 0 }, evidencePaths: [`/local/${INTERNAL_MARKER}/capture.html`], marker: INTERNAL_MARKER },
  };
}
