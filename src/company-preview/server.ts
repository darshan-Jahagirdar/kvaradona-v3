import 'server-only';
import { userClient } from '../persistence/server';
import { authorizeCompanyPreview, type PreviewAccess, type PreviewAuthClient } from './access';

/**
 * The only place the private payload is read: a Node server module, on request, after sign-in and
 * exact organization membership are established. It is never a `NEXT_PUBLIC_` variable, never read
 * at build time and never imported by the proxy.
 */
export async function loadCompanyPreview(): Promise<PreviewAccess> {
  const client = await userClient();
  return authorizeCompanyPreview(client as unknown as PreviewAuthClient, process.env);
}
