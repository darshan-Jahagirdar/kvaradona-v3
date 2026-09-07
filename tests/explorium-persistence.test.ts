import {it,expect} from 'vitest';import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
import {testDatabase,seed,localStore,org,user,otherOrg,campaign,enqueue} from './database';import {Job} from '../src/contracts/pipeline';
const migration='supabase/migrations/20260907162737_explorium_intent_discovery.sql';
it('launches verified intent with quota/tenant guards and cursor, only researches qualified dated matches, preserves records and recovers',async()=>{
 const db=await testDatabase();try{
 await seed(db);for(const file of ['20260906154157_complementary_discovery.sql','20260907133534_review_workflow.sql','20260907143733_apollo_company_discovery.sql','20260907150818_intent_icp_gate.sql'])await db.exec(await readFile('supabase/migrations/'+file,'utf8'));
 const prior=(await db.query<{definition:string}>("select pg_get_functiondef('private.start_workflow(uuid,uuid)'::regprocedure) definition")).rows[0].definition;
 await db.exec(await readFile(migration,'utf8'));
 const jid=await enqueue(db);await db.exec("update public.jobs set status='done';update public.budget set live_enabled=true;update public.provider_limits set verified_at=now(),probe_enabled=true,free_units=100,evidence=jsonb_build_object('kind','verified_trial','trialValidUntil',now()+interval '1 day')::text where provider in ('openai','brave','explorium')");
 for(const provider of ['openai','brave'])await db.query("insert into public.provider_operations(organization_id,job_id,campaign_id,operation_key,provider,request_hash,state,reserved_usd,actual_usd,units) values($1,$2,$3,$4,$4,'h','succeeded',0.01,0.01,0)",[org,jid,campaign,provider]);
 const before=(await db.query('select * from public.provider_operations order by id')).rows;
 const store=localStore(db),args={p_organization:org,p_request:randomUUID()};await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${user}',false)`);
 await expect(store.rpc('start_workflow',{...args,p_organization:otherOrg})).rejects.toThrow('membership_required');
 const run=await store.rpc('start_workflow',args) as {id:string};expect((await store.rpc('start_workflow',args) as any).id).toBe(run.id);
 await db.exec('reset role');const job=Job.parse(await store.rpc('claim_job',{p_worker:'fixture'}));expect((job.payload as any).groups[0].source).toBe('explorium');
 const candidate=(id:string,status:string,intent:string,domain=id+'.example')=>({source:'explorium',title:id,eventKey:id,url:'https://'+domain,providerCompany:{provider:'explorium',id,name:id,domain,icp:{status},intent:{status:intent}}});
 expect(await store.rpc('ingest_company_discovery',{p_job:job.id,p_token:job.attempt_token,p_candidates:[candidate('fit','match','provider_reported'),candidate('boundary','unknown','provider_reported'),candidate('undated','match','unknown'),candidate('removed','match','provider_reported','github.com')],p_report:{maxResearch:3,mode:'fixture',providerResult:{nextCursor:'verified-cursor'}}})).toBe(true);
 expect((await db.query("select * from public.jobs where stage='S04'")).rows).toHaveLength(1);expect((await db.query('select source from public.company_discovery_observations')).rows).toEqual([{source:'explorium'},{source:'explorium'},{source:'explorium'}]);
 expect((await db.query("select * from public.opportunities where event_key='removed'")).rows).toHaveLength(0);
 await db.exec("update public.jobs set status='done'");await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${user}',false)`);await store.rpc('start_workflow',{...args,p_request:randomUUID()});await db.exec('reset role');
 expect((await db.query<{payload:any}>("select payload from public.jobs where status='queued'")).rows[0].payload.groups[0].nextCursor).toBe('verified-cursor');
 expect((await db.query('select * from public.provider_operations order by id')).rows).toEqual(before);
 await db.exec("update public.jobs set status='done';update public.provider_limits set free_units=15 where provider='explorium'");await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${user}',false)`);await expect(store.rpc('start_workflow',{...args,p_request:randomUUID()})).rejects.toThrow('provider_unverified');await db.exec('reset role');
 const rowsBefore=(await db.query('select * from public.opportunities order by id')).rows;await db.exec(await readFile('supabase/recovery/013_explorium_intent_discovery.sql','utf8'));expect((await db.query<{usable:boolean}>("select usable from public.provider_limits where provider='explorium'")).rows[0].usable).toBe(false);await db.exec(prior);await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${user}',false)`);await expect(store.rpc('start_workflow',{...args,p_request:randomUUID()})).rejects.toThrow('apollo_intent_access_unverified');await db.exec('reset role');expect((await db.query('select * from public.opportunities order by id')).rows).toEqual(rowsBefore);
 }finally{await db.close();}
});
