import {expect,it} from 'vitest';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {testDatabase,seed,localStore,org,user,otherOrg,enqueue} from './database';
const migration='supabase/migrations/20260907133534_review_workflow.sql';
it('launches one bounded batch, prevents duplicates and cross-tenant starts, preserves budget/unknown charges, and recovers without deletion',async()=>{
 const db=await testDatabase();try{
 await seed(db);await db.exec('alter table public.campaigns add column discovery_cursor integer not null default 0');await db.exec(await readFile(migration,'utf8'));
 const jid=await enqueue(db);await db.exec("update public.budget set live_enabled=true;update public.provider_limits set verified_at=now(),expires_at=now()-interval '1 day',probe_enabled=true where provider in('openai','brave');");
 for(const provider of ['openai','brave'])await db.query("insert into public.provider_operations(organization_id,job_id,campaign_id,operation_key,provider,request_hash,state,reserved_usd,actual_usd,units) select organization_id,id,campaign_id,$2,$2,'hash','succeeded',0.01,0.01,0 from public.jobs where id=$1",[jid,provider]);
 await db.query("insert into public.provider_operations(organization_id,job_id,campaign_id,operation_key,provider,request_hash,state,reserved_usd,units) select organization_id,id,campaign_id,'unknown','openai','hash','ambiguous',0.08,0 from public.jobs where id=$1",[jid]);
 const before=(await db.query('select * from public.provider_operations order by operation_key')).rows;
 const store=localStore(db);await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${user}',false)`);
 const args={p_organization:org,p_request:randomUUID()};const result=await store.rpc('start_workflow',args) as {id:string};
 expect((await store.rpc('start_workflow',args) as {id:string}).id).toBe(result.id);
 expect((await store.rpc('start_workflow',{...args,p_request:randomUUID()}) as {id:string}).id).toBe(result.id);
 await expect(store.rpc('start_workflow',{...args,p_organization:otherOrg})).rejects.toThrow('membership_required');
 expect((await db.query("select * from public.jobs where stage='S02'")).rows).toHaveLength(5);
 expect((await db.query('select * from public.workflow_runs')).rows).toHaveLength(1);
 await db.exec('reset role');expect((await db.query('select * from public.provider_operations order by operation_key')).rows).toEqual(before);
 expect((await db.query<{limit_usd:string}>('select limit_usd from public.budget')).rows[0].limit_usd).toBe('1.00000000');
 await db.exec(await readFile('supabase/recovery/009_review_workflow.sql','utf8'));expect((await db.query("select * from public.jobs where stage='S02' and status='queued'")).rows).toHaveLength(0);expect((await db.query('select * from public.workflow_runs')).rows).toHaveLength(1);
 await db.exec(`set role anon`);await expect(store.rpc('start_workflow',args)).rejects.toThrow();
 }finally{await db.close();}
});
