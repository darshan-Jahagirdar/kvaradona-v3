import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
let loaded = false;
/** One root .env for app and worker. Existing process overrides win; never writes credentials. */
export function loadEnvironment() {
  if (loaded) return;
  try {
    const values = parseEnv(readFileSync(resolve(process.cwd(), '.env'), 'utf8'));
    for (const [key, value] of Object.entries(values)) if (process.env[key] === undefined) process.env[key] = value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('environment_read_failed'); }
  loaded = true;
}
export function required(name: string) {
  loadEnvironment();
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`configuration_missing:${name}`);
  return value;
}
export const credentialNames = {
  supabase: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY'],
  openai: ['OPENAI_API_KEY'], brave: ['BRAVE_SEARCH_API_KEY'], apollo: ['APOLLO_API_KEY'],
  theirstack: ['THEIRSTACK_API_KEY'], predictleads: ['PREDICTLEADS_API_KEY', 'PREDICTLEADS_API_TOKEN'],
  hirebase: ['HIREBASE_API_KEY'], sam: ['SAM_GOV_API_KEY'], pagespeed: ['PAGESPEED_API_KEY'],
} as const;
export function configurationReport() {
  loadEnvironment();
  return Object.entries(credentialNames).map(([provider, keys]) => ({ provider,
    configured: keys.every(key => Boolean(process.env[key]?.trim())),
    authenticated: 'unverified', endpoint: 'unverified', quota: 'unverified', enabled: false,
  }));
}
