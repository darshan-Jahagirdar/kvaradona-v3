import { parseCompanyPreview, toDisplay, type DisplayContent } from './content';
import { previewPermitted, PREVIEW_DATA, PREVIEW_ORGANIZATION } from './mode';

type Env = Record<string, string | undefined>;

/** The two calls this check makes, on the ordinary user-scoped client. No service key is involved. */
export interface PreviewAuthClient {
  auth: { getUser(): Promise<{ data: { user: { id: string } | null } }> };
  from(table: 'memberships'): {
    select(columns: 'organization_id'): {
      eq(column: 'user_id', value: string): {
        eq(column: 'organization_id', value: string): {
          maybeSingle(): PromiseLike<{ data: { organization_id: string } | null; error: unknown }>;
        };
      };
    };
  };
}

export type PreviewAccess =
  | { status: 'ok'; content: DisplayContent }
  /** Feature off, or a production environment: nothing is served and nothing is explained. */
  | { status: 'unavailable' }
  /** Deployment misconfigured or payload invalid. Content is never partially shown. */
  | { status: 'misconfigured' }
  | { status: 'signin' }
  | { status: 'forbidden' }
  | { status: 'check_failed' };

const Uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decide whether this request may see the reviewed company research.
 *
 * Order matters: the environment gate, then configuration, then identity, then membership of the
 * ONE configured organization — and only then is the payload parsed. The organization comes from
 * deployment configuration, never from the request, so a signed-in member of another organization
 * cannot ask for it.
 */
export async function authorizeCompanyPreview(client: PreviewAuthClient, env: Env = process.env): Promise<PreviewAccess> {
  if (!previewPermitted(env)) return { status: 'unavailable' };
  const organizationId = env[PREVIEW_ORGANIZATION]?.trim();
  if (!organizationId || !Uuid.test(organizationId)) return { status: 'misconfigured' };

  const { data: { user } } = await client.auth.getUser();
  if (!user) return { status: 'signin' };

  const membership = await client.from('memberships').select('organization_id')
    .eq('user_id', user.id).eq('organization_id', organizationId).maybeSingle();
  if (membership.error) return { status: 'check_failed' };
  if (membership.data?.organization_id !== organizationId) return { status: 'forbidden' };

  const parsed = parseCompanyPreview(env[PREVIEW_DATA]);
  if (!parsed.ok) return { status: 'misconfigured' };
  return { status: 'ok', content: toDisplay(parsed.content) };
}
