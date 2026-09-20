import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import type { Store } from '../src/persistence/client';
export const migrationPath = 'supabase/migrations/20260906110533_foundation_execution.sql';
async function bootstrap(db:PGlite){
 await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth; create table auth.users(id uuid primary key,email text);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema public,auth to anon,authenticated,service_role; grant execute on function auth.uid() to public;`);
}
export async function testDatabase() {
 const db=new PGlite();
 await bootstrap(db);
 await db.exec(await readFile(migrationPath,'utf8'));
 return db;
}
/** Every migration in order, so a change can be exercised against the real accumulated schema.
 *  Supabase Storage is not part of PGlite, so the bucket migration is stubbed rather than skipped. */
export async function migratedDatabase(){
 const db=new PGlite();
 await bootstrap(db);
 // Supabase Storage is a managed schema PGlite does not ship. Stub the two objects the capture
 // migration touches so the chain applies in order; nothing here exercises Storage behaviour.
 await db.exec(`create schema storage;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[],created_at timestamptz default now());
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid,metadata jsonb);
 alter table storage.objects enable row level security;`);
 const files=(await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort();
 for(const f of files){
  try{await db.exec(await readFile(`supabase/migrations/${f}`,'utf8'));}
  catch(e){throw new Error(`migration ${f} failed: ${(e as Error).message}`);}
 }
 return db;
}
/** Run a statement as an authenticated end user, exactly as PostgREST would. */
export async function asUser<T>(db:PGlite,userId:string,run:()=>Promise<T>):Promise<T>{
 await db.exec(`set local role authenticated`).catch(()=>{});
 await db.query(`select set_config('request.jwt.claim.sub',$1,false)`,[userId]);
 await db.exec(`set role authenticated`);
 try{return await run();}finally{await db.exec(`reset role`);await db.query(`select set_config('request.jwt.claim.sub','',false)`);}
}
export function localStore(db:PGlite):Store {
 return {async rpc(name,args) {
  if(!/^[a-z_]+$/.test(name)||Object.keys(args).some(k=>!/^p_[a-z_]+$/.test(k))) throw new Error('invalid_rpc');
  const params=Object.entries(args);
  const query=`select public.${name}(${params.map(([k],i)=>`${k} => $${i+1}`).join(',')}) as value`;
  return (await db.query<{value:unknown}>(query,params.map(([,v])=>v!==null && typeof v==='object'?JSON.stringify(v):v))).rows[0].value;
 }};
}
export const org='10000000-0000-4000-8000-000000000001', otherOrg='10000000-0000-4000-8000-000000000002';
export const user='20000000-0000-4000-8000-000000000001', otherUser='20000000-0000-4000-8000-000000000002';
export const campaign='30000000-0000-4000-8000-000000000001', opportunity='40000000-0000-4000-8000-000000000001';
export async function seed(db:PGlite) {
 await db.query(`insert into auth.users values($1,'reviewer@example.invalid'),($2,'other@example.invalid')`,[user,otherUser]);
 await db.query(`insert into public.organizations(id,name) values($1,'Fixture company'),($2,'Other tenant')`,[org,otherOrg]);
 await db.query(`insert into public.memberships values($1,$2,'admin'),($3,$4,'admin')`,[org,user,otherOrg,otherUser]);
 await db.query(`insert into public.campaigns(id,organization_id,name,profile,paused) values($1,$2,'Fixture campaign','{}',false)`,[campaign,org]);
 await db.query(`insert into public.opportunities(id,organization_id,campaign_id,event_key,packet) values($1,$2,$3,'fixture-event','{"mode":"fixture","state":"discovered","evidence":[]}')`,[opportunity,org,campaign]);
}
export async function enqueue(db:PGlite,key='start') {
 return (await db.query<{id:string}>(`insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
 values($1,$2,$3,$4,'S06','fixture-hash',1,'1','1','{}') returning id`,[org,campaign,opportunity,key])).rows[0].id;
}
