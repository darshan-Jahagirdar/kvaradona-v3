/** Configuration fingerprint for diagnosing a sign-in failure.
 *
 *  Deliberately contains NO key material: only the project host and which key FORMAT is configured.
 *  That is enough to tell a wrong project or a stale legacy key from a genuine credential problem,
 *  and it can be logged safely. Never add the key itself, a prefix of it, an email or a password. */
export function authConfigFingerprint(){
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()??'';
 const key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()??'';
 let host='(missing)';
 if(url){try{host=new URL(url).host;}catch{host='(unparseable)';}}
 const keyFormat=!key?'(missing)'
  :key.startsWith('sb_publishable_')?'publishable'
  :key.startsWith('sb_secret_')?'SECRET_KEY_MISCONFIGURED'
  :key.startsWith('eyJ')?'legacy_jwt'
  :'unrecognized';
 return {host,keyFormat,keyPresent:Boolean(key)};
}
