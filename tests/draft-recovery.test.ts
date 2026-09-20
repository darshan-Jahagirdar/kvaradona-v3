import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {PGlite} from '@electric-sql/pglite';
import {migratedDatabase,localStore,seed,org,campaign,opportunity} from './database';
import {OperationGateway} from '../src/usage/operations';
import {Job} from '../src/contracts/pipeline';

/** The defect this proves: requeueing a job keeps its business_key, so the gateway REPLAYS the
 *  settled response. A new logical attempt must change the key, and an uncertain dispatch must not
 *  be re-dispatched under any circumstances. Exercised against real SQL, not string labels. */
const Body=z.object({text:z.string()});

async function runningJob(db:PGlite,businessKey:string){
 const id=(await db.query<{id:string}>(`insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
  values($1,$2,$3,$4,'S11','h',1,'1','1','{}') returning id`,[org,campaign,opportunity,businessKey])).rows[0].id;
 const token=(await db.query<{attempt_token:string}>(
  `update public.jobs set status='running',attempt_token=gen_random_uuid(),lease_until=now()+interval '90 seconds' where id=$1 returning attempt_token`,[id])).rows[0].attempt_token;
 return Job.parse((await db.query<{j:unknown}>(`select to_jsonb(j) as j from public.jobs j where id=$1`,[id])).rows[0].j);
}

async function enable(db:PGlite){
 await db.query(`update public.budget set live_enabled=true,dollar_limits_enabled=false where id=1`);
 await db.query(`update public.provider_limits set verified_at=now(),probe_enabled=true,expires_at=now()+interval '1 day' where provider='openai'`);
}

it('replays a settled response under the same key, and only a new attempt key generates again',async()=>{
 const db=await migratedDatabase();await seed(db);await enable(db);
 const store=localStore(db);
 const job=await runningJob(db,'draft-key');
 const gateway=new OperationGateway(store,job);

 let generated=0;
 const call=(key:string,text:string)=>gateway.run(key,'openai',{k:key},'0.01',0,Body,async()=>{
  generated++;return {response:{text},usage:{},actual:'0.005'};});

 const first=await call('draft','first output');
 expect(first.text).toBe('first output');
 expect(generated).toBe(1);

 // Same key after a requeue: the settled operation is returned, NOT a new generation.
 const replay=await call('draft','second output');
 expect(replay.text).toBe('first output');
 expect(generated).toBe(1);

 // The durable attempt key is a different operation, so the model is actually asked again.
 const retried=await call('draft_attempt_1','second output');
 expect(retried.text).toBe('second output');
 expect(generated).toBe(2);

 const ops=await db.query<{operation_key:string}>(`select operation_key from public.provider_operations order by created_at`);
 expect(ops.rows.map(r=>r.operation_key)).toEqual(['draft-key:draft','draft-key:draft_attempt_1']);
});

it('never redispatches an uncertain operation, even under a retry',async()=>{
 const db=await migratedDatabase();await seed(db);await enable(db);
 const store=localStore(db);
 const job=await runningJob(db,'ambiguous-key');
 const gateway=new OperationGateway(store,job);

 await expect(gateway.run('draft','openai',{k:1},'0.01',0,Body,async()=>{throw new Error('provider exploded');}))
  .rejects.toThrow('ambiguous_provider_operation');

 const held=await db.query<{state:string;actual_usd:string|null}>(`select state,actual_usd from public.provider_operations`);
 expect(held.rows).toEqual([{state:'dispatched',actual_usd:null}]);

 // The same key refuses rather than calling the provider a second time.
 let called=0;
 await expect(gateway.run('draft','openai',{k:1},'0.01',0,Body,async()=>{called++;return {response:{text:'x'},usage:{},actual:'0.005'};}))
  .rejects.toThrow('ambiguous_provider_operation');
 expect(called).toBe(0);
 // And the charge stays held, exactly once.
 expect((await db.query<{n:number}>(`select count(*)::int as n from public.provider_operations`)).rows[0].n).toBe(1);
});

it('survives a restart: a fresh gateway reuses the settled response and continues at the next attempt',async()=>{
 const db=await migratedDatabase();await seed(db);await enable(db);
 const store=localStore(db);
 const job=await runningJob(db,'restart-key');

 let generated=0;
 const make=()=>new OperationGateway(store,job);
 await make().run('draft','openai',{k:'a'},'0.01',0,Body,async()=>{generated++;return {response:{text:'kept'},usage:{},actual:'0.005'};});

 // A new process, a new gateway object: the settled response is still authoritative.
 const afterRestart=await make().run('draft','openai',{k:'a'},'0.01',0,Body,async()=>{generated++;return {response:{text:'regenerated'},usage:{},actual:'0.005'};});
 expect(afterRestart.text).toBe('kept');
 expect(generated).toBe(1);

 // The bounded next attempt still works after the restart.
 const next=await make().run('draft_attempt_1','openai',{k:'b'},'0.01',0,Body,async()=>{generated++;return {response:{text:'attempt two'},usage:{},actual:'0.005'};});
 expect(next.text).toBe('attempt two');
 expect(generated).toBe(2);
});

it('stops at the bound instead of minting attempt keys forever',async()=>{
 const db=await migratedDatabase();await seed(db);await enable(db);
 const store=localStore(db);
 const job=await runningJob(db,'bounded-key');
 const gateway=new OperationGateway(store,job);
 // S11 allows draft, draft_attempt_1, draft_attempt_2 and then stops at draft_exception.
 const keys=['draft','draft_attempt_1','draft_attempt_2'];
 for(const k of keys)await gateway.run(k,'openai',{k},'0.01',0,Body,async()=>({response:{text:k},usage:{},actual:'0.005'}));
 const ops=await db.query<{operation_key:string}>(`select operation_key from public.provider_operations order by created_at`);
 expect(ops.rows.map(r=>r.operation_key.split(':').pop())).toEqual(keys);
 expect(ops.rows).toHaveLength(3);
});
