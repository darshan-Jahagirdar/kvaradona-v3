import {readFile} from 'node:fs/promises';
import {expect,it} from 'vitest';
import {testDatabase,localStore,seed,enqueue,org,campaign,opportunity} from './database';
import {Job} from '../src/contracts/pipeline';
const migration='supabase/migrations/20260906131530_two_dollar_cap_and_bounded_draft_replacement.sql';
const reason='Explicit single Terra replacement after unknown Luna dispatch; keep its full reservation.';
it('raises the cumulative cap, preserves unknown charges, and rejects reservations beyond two dollars',async()=>{
 const db=await testDatabase();try{
  await seed(db);const id=await enqueue(db),store=localStore(db),job=Job.parse(await store.rpc('claim_job',{p_worker:'test'}));
  await db.query(`insert into public.provider_operations(organization_id,job_id,campaign_id,operation_key,provider,request_hash,state,reserved_usd,units) values($1,$2,$3,'old-unknown','openai','old','dispatched',0.0081406,0)`,[org,id,campaign]);
  await db.exec(await readFile(migration,'utf8'));
  expect((await db.query('select limit_usd::text from public.budget')).rows[0]).toEqual({limit_usd:'2.00000000'});
  expect((await db.query('select actual_usd,state,reserved_usd::text from public.provider_operations')).rows[0]).toEqual({actual_usd:null,state:'dispatched',reserved_usd:'0.00814060'});
  // Isolate the global ceiling from the independently stricter per-provider ceiling.
  await db.exec(`update public.budget set live_enabled=true; update public.provider_limits set limit_usd=3,probe_enabled=true,verified_at=now(),expires_at=now()+interval '1 hour' where provider='openai';`);
  const other=(await db.query<{id:string}>(`insert into public.campaigns(organization_id,name,profile) values($1,'Prior fixture usage','{}') returning id`,[org])).rows[0].id;
  await db.query(`insert into public.provider_operations(organization_id,job_id,campaign_id,operation_key,provider,request_hash,state,reserved_usd,actual_usd,units) values($1,$2,$3,'known','openai','known','succeeded',1.767446,1.767446,0)`,[org,id,other]);
  const reserve=(key:string,amount:string)=>store.rpc('reserve_operation',{p_job:id,p_token:job.attempt_token,p_key:key,p_provider:'openai',p_hash:key,p_max:amount,p_units:0});
  await reserve('allowed','0.224');await expect(reserve('over','0.001')).rejects.toThrow('budget');
  expect(Number((await db.query<{total:string}>('select sum(coalesce(actual_usd,reserved_usd))::text total from public.provider_operations')).rows[0].total)).toBeCloseTo(1.9995866,8);
 }finally{await db.close();}
});
it('queues one audited replacement, forbids chains/browser access, and leaves the original operation unsettled',async()=>{
 const db=await testDatabase();try{
  await seed(db);await db.exec(await readFile(migration,'utf8'));const store=localStore(db),id=await enqueue(db,'draft-original');
  await db.query(`update public.jobs set stage='S11',status='blocked' where id=$1;`,[id]);
  await db.query(`update public.opportunities set state='contact_pending',packet='{"mode":"fixture","state":"contact_pending","evidence":[],"packetReview":{"acceptable":true}}' where id=$1`,[opportunity]);
  const op=(await db.query<{id:string}>(`insert into public.provider_operations(organization_id,job_id,campaign_id,opportunity_id,operation_key,provider,request_hash,state,reserved_usd,units) values($1,$2,$3,$4,'draft-original:draft','openai','old','dispatched',0.0081406,0) returning id`,[org,id,campaign,opportunity])).rows[0].id;
  const args={p_operation:op,p_reason:reason};const replacement=await store.rpc('replace_ambiguous_draft',args);
  expect(await store.rpc('replace_ambiguous_draft',args)).toBe(replacement);
  await expect(store.rpc('replace_ambiguous_draft',{...args,p_reason:reason+' changed'})).rejects.toThrow('conflict');
  const row=(await db.query<{payload:{draftReplacement:{operationId:string,model:string}}}>('select payload from public.jobs where id=$1',[replacement])).rows[0];
  expect(row.payload.draftReplacement).toMatchObject({operationId:op,model:'gpt-5.6-terra'});
  expect((await db.query('select state,actual_usd,reserved_usd::text from public.provider_operations where id=$1',[op])).rows[0]).toEqual({state:'dispatched',actual_usd:null,reserved_usd:'0.00814060'});
  await db.query(`update public.jobs set status='blocked' where id=$1`,[replacement]);
  const second=(await db.query<{id:string}>(`insert into public.provider_operations(organization_id,job_id,campaign_id,operation_key,provider,request_hash,state,reserved_usd,units) select organization_id,id,campaign_id,business_key||':draft','openai','replacement','dispatched',0.08,0 from public.jobs where id=$1 returning id`,[replacement])).rows[0].id;
  await expect(store.rpc('replace_ambiguous_draft',{p_operation:second,p_reason:reason})).rejects.toThrow('not_eligible');
  await db.exec('set role authenticated');await expect(store.rpc('replace_ambiguous_draft',args)).rejects.toThrow('permission');await db.exec('reset role');
  // Settings recovery is safe below $1 and preserves the immutable cost/operation history.
  await db.exec(await readFile('supabase/recovery/004_budget_settings.sql','utf8'));
  expect((await db.query('select limit_usd::text,live_enabled from public.budget')).rows[0]).toEqual({limit_usd:'1.00000000',live_enabled:false});
  expect((await db.query('select * from public.provider_operations')).rows).toHaveLength(2);
 }finally{await db.close();}
});
