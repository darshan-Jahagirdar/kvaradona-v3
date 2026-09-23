/**
 * Company-research preview gating.
 *
 * `requested` means this deployment is configured as the read-only company preview. That alone is
 * enough to lock the workflow down: every existing API route refuses, and the landing page goes to
 * the company view instead of the inbox. Locking down is the safe direction, so it never depends on
 * anything else.
 *
 * `permitted` is stricter and governs whether private content may be served at all: a production
 * environment never serves it, even if the flag were set there by mistake.
 *
 * Deliberately free of payload access: this module is safe to evaluate anywhere, including the proxy.
 */
type Env = Record<string, string | undefined>;

export const PREVIEW_FLAG = 'KVARA_COMPANY_PREVIEW';
export const PREVIEW_ORGANIZATION = 'KVARA_COMPANY_PREVIEW_ORGANIZATION_ID';
export const PREVIEW_DATA = 'KVARA_COMPANY_PREVIEW_DATA';

export function previewRequested(env: Env = process.env) {
  return env[PREVIEW_FLAG] === '1';
}

export function previewPermitted(env: Env = process.env) {
  return previewRequested(env) && env.VERCEL_ENV !== 'production';
}

/**
 * The server-side refusal every existing route handler returns under the preview configuration.
 * Buttons being hidden is not enough: a request sent by hand must be refused too.
 */
export function previewLockdown(env: Env = process.env): Response | null {
  if (!previewRequested(env)) return null;
  return new Response(JSON.stringify({ error: 'This deployment is a read-only company research preview. Workflow, review, report and sending actions are disabled.' }), {
    status: 403,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });
}
