import { beforeAll,afterAll,beforeEach,afterEach,expect,it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { testDatabase,localStore,seed,enqueue,org,otherOrg,user,otherUser,campaign,opportunity } from './database';
import { Job } from '../src/contracts/pipeline';
import { OperationGateway } from '../src/usage/operations';
import { z } from 'zod';
let db:PGlite; let store:ReturnType<typeof localStore>;
beforeAll(async()=>{db=await testDatabase();store=localStore(db);await seed(db);});
afterAll(async()=>{await db.close();});
beforeEach(async()=>{await db.exec('begin');}); afterEach(async()=>{await db.exec('rollback');});
async function claim(){await enqueue(db);return Job.parse(await store.rpc('claim_job',{p_worker:'test'}));}
async function enable(){await db.exec(`update public.budget set live_enabled=true; update public.provider_limits set authenticated=true,usable=true,verified_at=now(),expires_at=now()+interval '1 hour' where provider='openai';`);}
it('isolates tenants, refuses cross-tenant attachments and blocks browser queue access',async()=>{
 await db.exec(`set local role authenticated; select set_config('request.jwt.claim.sub','${otherUser}',true);`);
 expect((await db.query('select * from public.opportunities')).rows).toHaveLength(0);
 await db.exec('savepoint isolation'); await expect(store.rpc('claim_job',{p_worker:'browser'})).rejects.toThrow(/permission/); await db.exec('rollback to isolation; reset role; savepoint cross_org');
 await expect(db.query(`insert into public.evidence(id,organization_id,opportunity_id,document) values(gen_random_uuid(),$1,$2,'{}')`,[otherOrg,opportunity])).rejects.toThrow(/foreign key/); await db.exec('rollback to cross_org');
});
it('fences an expired owner and atomically completes a stage plus exactly one successor',async()=>{
 const a=await claim();await db.query(`update public.jobs set lease_until=now()-interval '1 second' where id=$1`,[a.id]);
 const b=Job.parse(await store.rpc('claim_job',{p_worker:'replacement'}));
 expect(await store.rpc('complete_job',{p_job:a.id,p_token:a.attempt_token,p_output:{state:'stale'},p_next:null})).toBe(false);
 const args={p_job:b.id,p_token:b.attempt_token,p_output:{state:'researched',evidence:[]},p_next:{stage:'S09',business_key:'next',input_hash:'output-hash'}};
 expect(await store.rpc('complete_job',args)).toBe(true);expect(await store.rpc('complete_job',args)).toBe(true);
 expect((await db.query('select * from public.stage_runs')).rows).toHaveLength(1);
 expect((await db.query(`select * from public.jobs where business_key='next'`)).rows).toHaveLength(1);
});
it('retains ambiguous spend and never dispatches the same billable operation twice',async()=>{
 const job=await claim(); await enable();let calls=0;
 const gateway=new OperationGateway(store,job);
 const dispatch=async()=>{calls++;throw new Error('connection_lost_after_dispatch');};
 await expect(gateway.run('one','openai',{q:1},'0.10',0,z.object({ok:z.boolean()}),dispatch)).rejects.toThrow('ambiguous');
 await expect(gateway.run('one','openai',{q:1},'0.10',0,z.object({ok:z.boolean()}),dispatch)).rejects.toThrow('ambiguous');
 expect(calls).toBe(1); expect((await db.query<{total:string}>('select sum(reserved_usd)::text total from public.provider_operations')).rows[0].total).toBe('0.10000000');
});
it('recovers a lost settlement acknowledgement from the saved response without rebilling',async()=>{
 const job=await claim();await enable();let calls=0,lost=true;
 const unreliable={async rpc(name:string,args:Record<string,unknown>){const result=await store.rpc(name,args);if(name==='record_operation'&&lost){lost=false;throw new Error('lost_ack');}return result;}};
 const gateway=new OperationGateway(unreliable,job),schema=z.object({ok:z.boolean()});
 const dispatch=async()=>{calls++;return {response:{ok:true},usage:{input:10},actual:'0.01'};};
 expect(await gateway.run('one','openai',{},'0.10',0,schema,dispatch)).toEqual({ok:true});
 await gateway.run('one','openai',{},'0.10',0,schema,dispatch);expect(calls).toBe(1);
});
it('serializes competing reservations within a hard remaining budget',async()=>{
 const job=await claim();await enable();await db.exec('update public.budget set limit_usd=0.15');
 const reserve=(key:string)=>store.rpc('reserve_operation',{p_job:job.id,p_token:job.attempt_token,p_key:key,p_provider:'openai',p_hash:key,p_max:'0.10',p_units:0});
 // PGlite serializes SQL; the same row lock is exercised on actual Postgres in the hosted probe.
 const results=await Promise.allSettled([reserve('first'),reserve('second')]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
});
it('preserves edits, invalidates old worker versions, rejects duplicate request misuse',async()=>{
 const job=await claim();await db.exec(`set local role authenticated; select set_config('request.jwt.claim.sub','${user}',true);`);
 const request='50000000-0000-4000-8000-000000000001';const args={p_id:opportunity,p_revision:1,p_request:request,p_action:'edit',p_note:'Shorter useful offer',p_draft:{subject:'Workflow question',body:'Could an implementation outline be useful?',recipient:null,sender:null,claimIds:[]}};
 await store.rpc('review_opportunity',args);await store.rpc('review_opportunity',args);
 expect((await db.query('select * from public.reviews')).rows).toHaveLength(1);
 await db.exec('reset role');expect(await store.rpc('renew_job',{p_job:job.id,p_token:job.attempt_token})).toBe(false);
});
it('coalesces missed schedules and remains idle when a campaign is paused',async()=>{
 await db.query('update public.campaigns set profile=$1 where id=$2',[JSON.stringify({groupIndex:0,groups:[{country:'US',language:'en',query:'Synthetic query'}]}),campaign]);
 await db.query(`insert into public.schedules(organization_id,campaign_id,next_due,interval_seconds,enabled) values($1,$2,now()-interval '3 days',300,true)`,[org,campaign]);
 expect(await store.rpc('tick_schedules',{})).toBe(1);expect(await store.rpc('tick_schedules',{})).toBe(0);
 expect((await db.query('select * from public.jobs')).rows).toHaveLength(1);
 await db.exec('update public.campaigns set paused=true');expect(await store.rpc('claim_job',{p_worker:'paused'})).toBe(null);
});
