import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import type { Store } from '../src/persistence/client';
export const migrationPath = 'supabase/migrations/20260906110533_foundation_execution.sql';
export async function testDatabase() {
 const db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth; create table auth.users(id uuid primary key,email text);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema public,auth to anon,authenticated,service_role; grant execute on function auth.uid() to public;`);
 await db.exec(await readFile(migrationPath,'utf8'));
 return db;
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
