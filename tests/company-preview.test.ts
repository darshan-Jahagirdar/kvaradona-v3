import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentProblems, CompanyPreviewContent, parseCompanyPreview, toDisplay } from '../src/company-preview/content';
import { authorizeCompanyPreview, type PreviewAuthClient } from '../src/company-preview/access';
import { previewLockdown, previewPermitted } from '../src/company-preview/mode';
import { INTERNAL_MARKER, syntheticPreview } from './fixtures/company-preview';

vi.mock('server-only', () => ({}));

const ORG = '11111111-2222-4333-8444-555555555555';
const OTHER_ORG = '99999999-2222-4333-8444-555555555555';
const payload = () => JSON.stringify(syntheticPreview());
const previewEnv = (extra: Record<string, string | undefined> = {}) => ({
  KVARA_COMPANY_PREVIEW: '1', KVARA_COMPANY_PREVIEW_ORGANIZATION_ID: ORG, KVARA_COMPANY_PREVIEW_DATA: payload(), VERCEL_ENV: 'preview', ...extra,
});

/** A fake of the two user-scoped calls. It records every membership filter it receives. */
function fakeClient(user: { id: string } | null, memberOf: string[], opts: { error?: boolean } = {}) {
  const filters: [string, string][] = [];
  const client = {
    auth: { getUser: async () => ({ data: { user } }) },
    from: () => ({ select: () => ({ eq: (c1: string, v1: string) => ({ eq: (c2: string, v2: string) => ({
      maybeSingle: async () => {
        filters.push([c1, v1], [c2, v2]);
        if (opts.error) return { data: null, error: new Error('rls') };
        return { data: memberOf.includes(v2) ? { organization_id: v2 } : null, error: null };
      },
    }) }) }) }),
  } as unknown as PreviewAuthClient;
  return { client, filters };
}

describe('company preview content', () => {
  it('accepts the synthetic payload with intact references', () => {
    const parsed = parseCompanyPreview(payload());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(contentProblems(parsed.content)).toEqual([]);
  });

  it('fails closed on missing, malformed and unexpected payloads without echoing content', () => {
    expect(parseCompanyPreview(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(parseCompanyPreview('  ')).toEqual({ ok: false, reason: 'missing' });
    expect(parseCompanyPreview('{not json')).toEqual({ ok: false, reason: 'malformed' });
    const extra = { ...syntheticPreview(), score: 97 };
    expect(parseCompanyPreview(JSON.stringify(extra))).toEqual({ ok: false, reason: 'invalid' });
    const three = syntheticPreview(); three.companies.pop();
    expect(parseCompanyPreview(JSON.stringify(three))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('requires exactly three pain points, each marked observed or to validate', () => {
    const two = syntheticPreview(); two.companies[0].painPoints.pop();
    expect(parseCompanyPreview(JSON.stringify(two)).ok).toBe(false);
    const unlabeled = syntheticPreview() as unknown as { companies: { painPoints: { status: string }[] }[] };
    unlabeled.companies[1].painPoints[0].status = 'confirmed';
    expect(parseCompanyPreview(JSON.stringify(unlabeled)).ok).toBe(false);
  });

  it('rejects broken fact, source and contact references', () => {
    const cases: ((c: ReturnType<typeof syntheticPreview>) => void)[] = [
      c => { c.companies[0].facts[0].sourceIds = ['nope']; },
      c => { c.companies[0].inferences[0].factIds = ['nope']; },
      c => { c.companies[0].painPoints[0].factIds = ['nope']; },
      c => { c.companies[1].contact.roleSourceIds = ['nope']; },
      c => { c.companies[2].facts[1].id = c.companies[2].facts[0].id; },
      c => { c.companies[3].id = c.companies[2].id; },
    ];
    for (const mutate of cases) {
      const c = syntheticPreview(); mutate(c);
      const parsed = CompanyPreviewContent.parse(c);
      expect(contentProblems(parsed).length).toBeGreaterThan(0);
      expect(parseCompanyPreview(JSON.stringify(c)).ok).toBe(false);
    }
  });

  it('keeps an unresolved email unresolved: no address, no recipient, no invented source', () => {
    const invented = syntheticPreview(); invented.companies[0].contact.email = 'guess@alpha.example.org' as never;
    expect(parseCompanyPreview(JSON.stringify(invented)).ok).toBe(false);
    const sourced = syntheticPreview(); sourced.companies[0].contact.emailSourceIds = ['alpha-s2'] as never;
    expect(parseCompanyPreview(JSON.stringify(sourced)).ok).toBe(false);
    const recipient = syntheticPreview(); recipient.companies[0].draft.recipientEmail = 'guess@alpha.example.org' as never;
    expect(parseCompanyPreview(JSON.stringify(recipient)).ok).toBe(false);
    const unsupported = syntheticPreview(); unsupported.companies[1].contact.emailSourceIds = [];
    expect(parseCompanyPreview(JSON.stringify(unsupported)).ok).toBe(false);
    const mismatch = syntheticPreview(); mismatch.companies[1].draft.recipientEmail = 'other@beta.example.org';
    expect(parseCompanyPreview(JSON.stringify(mismatch)).ok).toBe(false);
  });

  it('projects only display fields: no internal provenance, accounting or evidence paths', () => {
    const parsed = parseCompanyPreview(payload());
    if (!parsed.ok) throw new Error('fixture invalid');
    const display = toDisplay(parsed.content), json = JSON.stringify(display);
    expect(json).not.toContain(INTERNAL_MARKER);
    expect(json).not.toContain('apolloLookups');
    expect(json).not.toContain('internal');
    expect(json).not.toContain('sourceIds');
    expect(display.counts).toEqual({ companies: 4, workEmails: 3, drafts: 4, draftsWithoutRecipient: 1 });
    expect(display.companies.map(c => c.painPoints.map(p => p.label))).toEqual([
      ['Observed', 'To validate', 'To validate'], ['Observed', 'To validate', 'To validate'],
      ['To validate', 'To validate', 'To validate'], ['To validate', 'To validate', 'To validate'],
    ]);
    expect(display.companies[0].contact.email).toBeNull();
    expect(display.companies[0].draft.recipientEmail).toBeNull();
    expect(display.companies[0].draft.body).toContain('[Your name]');
  });
});

describe('company preview access', () => {
  it('serves nothing when the feature is off or the environment is production', async () => {
    const { client, filters } = fakeClient({ id: 'u1' }, [ORG]);
    expect(await authorizeCompanyPreview(client, previewEnv({ KVARA_COMPANY_PREVIEW: undefined }))).toEqual({ status: 'unavailable' });
    expect(await authorizeCompanyPreview(client, previewEnv({ KVARA_COMPANY_PREVIEW: 'true' }))).toEqual({ status: 'unavailable' });
    expect(await authorizeCompanyPreview(client, previewEnv({ VERCEL_ENV: 'production' }))).toEqual({ status: 'unavailable' });
    expect(filters).toEqual([]);
    expect(previewPermitted(previewEnv({ VERCEL_ENV: 'production' }))).toBe(false);
  });

  it('fails closed on missing or malformed organization configuration', async () => {
    const { client } = fakeClient({ id: 'u1' }, [ORG]);
    expect(await authorizeCompanyPreview(client, previewEnv({ KVARA_COMPANY_PREVIEW_ORGANIZATION_ID: undefined }))).toEqual({ status: 'misconfigured' });
    expect(await authorizeCompanyPreview(client, previewEnv({ KVARA_COMPANY_PREVIEW_ORGANIZATION_ID: 'org-1' }))).toEqual({ status: 'misconfigured' });
  });

  it('asks unauthenticated callers to sign in before any membership or payload check', async () => {
    const { client, filters } = fakeClient(null, [ORG]);
    expect(await authorizeCompanyPreview(client, previewEnv())).toEqual({ status: 'signin' });
    expect(filters).toEqual([]);
  });

  it('refuses a signed-in member of a different organization', async () => {
    const { client, filters } = fakeClient({ id: 'u2' }, [OTHER_ORG]);
    expect(await authorizeCompanyPreview(client, previewEnv())).toEqual({ status: 'forbidden' });
    expect(filters).toEqual([['user_id', 'u2'], ['organization_id', ORG]]);
  });

  it('reports a failed membership check without showing content', async () => {
    const { client } = fakeClient({ id: 'u1' }, [ORG], { error: true });
    expect(await authorizeCompanyPreview(client, previewEnv())).toEqual({ status: 'check_failed' });
  });

  it('shows the display projection only to a member of the exact configured organization', async () => {
    const { client, filters } = fakeClient({ id: 'u1' }, [ORG]);
    const access = await authorizeCompanyPreview(client, previewEnv());
    expect(access.status).toBe('ok');
    expect(filters).toEqual([['user_id', 'u1'], ['organization_id', ORG]]);
    expect(JSON.stringify(access)).not.toContain(INTERNAL_MARKER);
  });

  it('fails closed for an authorized member when the payload is missing or invalid', async () => {
    const { client } = fakeClient({ id: 'u1' }, [ORG]);
    expect(await authorizeCompanyPreview(client, previewEnv({ KVARA_COMPANY_PREVIEW_DATA: undefined }))).toEqual({ status: 'misconfigured' });
    expect(await authorizeCompanyPreview(client, previewEnv({ KVARA_COMPANY_PREVIEW_DATA: '{"schemaVersion":1}' }))).toEqual({ status: 'misconfigured' });
  });
});

describe('preview lockdown of the existing workflow', () => {
  const saved = { ...process.env };
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { process.env = { ...saved }; vi.doUnmock('../src/persistence/server'); vi.doUnmock('next/navigation'); });

  it('is inactive when the preview is not configured', () => {
    expect(previewLockdown({})).toBeNull();
    expect(previewLockdown({ KVARA_COMPANY_PREVIEW: '0' })).toBeNull();
  });

  it('refuses every existing route handler server-side before any database access', async () => {
    process.env.KVARA_COMPANY_PREVIEW = '1';
    const userClient = vi.fn(async () => { throw new Error('database must not be touched'); });
    vi.doMock('../src/persistence/server', () => ({ userClient }));
    const handlers: [string, 'GET' | 'POST'][] = [
      ['review', 'POST'], ['workflow', 'POST'], ['workflow', 'GET'], ['selected-workflow', 'POST'], ['selected-workflow', 'GET'],
      ['quality', 'POST'], ['report', 'GET'], ['website-artifact', 'GET'],
    ];
    for (const [route, method] of handlers) {
      const mod = await import(`../app/api/${route}/route.ts`) as Record<string, (req: Request) => Promise<Response>>;
      const res = await mod[method](new Request(`https://preview.example.org/api/${route}`, { method, headers: { origin: 'https://preview.example.org' }, body: method === 'POST' ? '{}' : undefined }));
      expect(res.status, `${method} /api/${route}`).toBe(403);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    }
    expect(userClient).not.toHaveBeenCalled();
  });

  it('keeps existing routes reachable when the preview is not configured', async () => {
    delete process.env.KVARA_COMPANY_PREVIEW;
    const getUser = vi.fn(async () => ({ data: { user: null } }));
    vi.doMock('../src/persistence/server', () => ({ userClient: async () => ({ auth: { getUser } }) }));
    const { GET } = await import('../app/api/report/route');
    const res = await GET();
    expect(res.status).toBe(401);
    expect(getUser).toHaveBeenCalled();
  });

  it('sends the landing page to the company view before any inbox query', async () => {
    process.env.KVARA_COMPANY_PREVIEW = '1';
    const userClient = vi.fn(async () => { throw new Error('inbox must not be queried'); });
    vi.doMock('../src/persistence/server', () => ({ userClient }));
    vi.doMock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`redirect:${to}`); }, notFound: () => { throw new Error('notFound'); } }));
    const { default: Inbox } = await import('../app/page');
    await expect(Inbox({ searchParams: Promise.resolve({}) })).rejects.toThrow('redirect:/companies');
    expect(userClient).not.toHaveBeenCalled();
  });

  it('does not serve the company view on a deployment without the preview', async () => {
    delete process.env.KVARA_COMPANY_PREVIEW;
    vi.doMock('../src/persistence/server', () => ({ userClient: async () => fakeClient({ id: 'u1' }, [ORG]).client }));
    vi.doMock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`redirect:${to}`); }, notFound: () => { throw new Error('notFound'); } }));
    vi.doMock('next/server', async importOriginal => ({ ...(await importOriginal<object>()), connection: async () => undefined }));
    const { default: Companies } = await import('../app/companies/page');
    await expect(Companies()).rejects.toThrow('notFound');
    vi.doUnmock('next/server');
  });
});
