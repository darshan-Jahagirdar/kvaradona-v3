import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {testDatabase,seed,localStore,org,user,otherOrg,campaign,enqueue} from './database';
import {Job} from '../src/contracts/pipeline';
import {intentWorkflowProfile} from '../src/domain/intent-icp';
const migration='supabase/migrations/20260908081150_three_dollar_501_intent_test.sql';
async function setup(){
 const db=await testDatabase();await seed(db);
 for(const file of ['20260906131530_two_dollar_cap_and_bounded_draft_replacement.sql','20260906154157_complementary_discovery.sql','20260907133534_review_workflow.sql','20260907143733_apollo_company_discovery.sql','20260907150818_intent_icp_gate.sql','20260907162737_explorium_intent_discovery.sql','20260907174500_research_four_per_run.sql','20260908072105_intent_topics_context_accounting.sql'])await db.exec(await readFile('supabase/migrations/'+file,'utf8'));
 const prior=(await db.query<{profile:any}>("select profile from public.workflow_profiles where id='focused-v1'")).rows[0].profile;
 await db.exec(await readFile(migration,'utf8'));
 const jid=await enqueue(db);await db.exec("update public.jobs set status='done';update public.budget set live_enabled=true,limit_usd=2;update public.provider_limits set limit_usd=2,verified_at=now(),expires_at=now()+interval '1 hour',probe_enabled=true,free_units=100,evidence=jsonb_build_object('kind','verified_trial','trialValidUntil',now()+interval '1 day')::text where provider in('openai','brave','explorium','apollo')");
 for(const provider of ['openai','brave'])await db.query("insert into public.provider_operations(organization_id,job_id,campaign_id,operation_key,provider,request_hash,state,reserved_usd,actual_usd,units) values($1,$2,$3,$4,$4,'h','succeeded',0.01,0.01,0)",[org,jid,campaign,provider]);
 return {db,jid,store:localStore(db),prior};
}
async function login(db:any){await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${user}',false)`);}
async function operation(db:any,jid:string,units:number,actual:unknown,state='succeeded',responseActual:unknown=actual,provider='explorium'){
 return (await db.query("insert into public.provider_operations(organization_id,job_id,campaign_id,operation_key,provider,request_hash,state,reserved_usd,actual_usd,units,usage,response) values($1,$2,$3,$4,$5,'h',$6,0,$7,$8,$9,$10) returning id",[org,jid,campaign,randomUUID(),provider,state,state==='succeeded'?0:null,units,JSON.stringify({actualCredits:actual}),JSON.stringify({httpStatus:200,body:{credit_usage:{total_credits:responseActual}}})])).rows[0].id;
}
it('uses only identical ingested search definitions for cursor continuation, keeps four-company bounds/replay/tenancy and recovers without losing records',async()=>{
 const {db,store,prior}=await setup();try{
 expect((await db.query<{profile:any}>("select profile from public.workflow_profiles where id='focused-v1'")).rows[0].profile).toEqual(intentWorkflowProfile);
 await login(db);await expect(store.rpc('start_workflow',{p_organization:otherOrg,p_request:randomUUID()})).rejects.toThrow('membership_required');
 const args={p_organization:org,p_request:randomUUID()},run:any=await store.rpc('start_workflow',args);expect((await store.rpc('start_workflow',args) as any).id).toBe(run.id);
 await db.exec('reset role');const job=Job.parse(await store.rpc('claim_job',{p_worker:'fixture'}));const definition=(job.payload as any).groups[0].searchDefinition;
 const candidates=Array.from({length:4},(_,i)=>({source:'explorium',title:'Fixture '+i,eventKey:'fixture-'+i,url:`https://fixture${i}.example`,providerCompany:{provider:'explorium',id:'fixture-'+i,name:'Fixture '+i,domain:`fixture${i}.example`,icp:{status:'match'},intent:{status:'provider_reported'}}}));
 const report={maxResearch:4,mode:'fixture',providerResult:{nextCursor:'v10-cursor',searchDefinition:definition}};
 await expect(store.rpc('ingest_company_discovery',{p_job:job.id,p_token:job.attempt_token,p_candidates:candidates,p_report:{...report,providerResult:{nextCursor:'bad'}}})).rejects.toThrow('intent_search_definition_mismatch');
 const ingestion={p_job:job.id,p_token:job.attempt_token,p_candidates:candidates,p_report:report};expect(await store.rpc('ingest_company_discovery',ingestion)).toBe(true);expect(await store.rpc('ingest_company_discovery',ingestion)).toBe(true);expect((await db.query("select id from public.jobs where stage='S04'")).rows).toHaveLength(4);
 await db.exec("update public.jobs set status='done'");await login(db);await store.rpc('start_workflow',{p_organization:org,p_request:randomUUID()});await db.exec('reset role');
 let payload=(await db.query<{payload:any}>("select payload from public.jobs where status='queued'")).rows[0].payload;expect(payload.groups[0].nextCursor).toBe('v10-cursor');
 await db.exec("update public.jobs set status='done'");await db.query("update public.stage_runs set output=jsonb_set(output,'{providerResult,nextCursor}','null') where job_id=$1",[job.id]);
 await login(db);await expect(store.rpc('start_workflow',{p_organization:org,p_request:randomUUID()})).rejects.toThrow('intent_search_exhausted');await db.exec('reset role');
 await db.exec("update public.jobs set status='done';update public.workflow_profiles set profile=jsonb_set(profile,'{groups,0,searchDefinition,pageSize}','3') where id='focused-v1'");
 await login(db);await store.rpc('start_workflow',{p_organization:org,p_request:randomUUID()});await db.exec('reset role');payload=(await db.query<{payload:any}>("select payload from public.jobs where status='queued'")).rows[0].payload;expect(payload.groups[0].nextCursor).toBeUndefined();
 const tables=['opportunities','jobs','company_discovery_observations','provider_operations'];
 const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,(await db.query(`select to_jsonb(t) row from public.${t} t order by to_jsonb(t)::text`)).rows])));
 const before=await snapshot();await db.exec(await readFile('supabase/recovery/016_three_dollar_501_intent_test.sql','utf8'));expect(await snapshot()).toEqual(before);expect((await db.query<{profile:any}>("select profile from public.workflow_profiles where id='focused-v1'")).rows[0].profile).toEqual(prior);
 }finally{await db.close();}
});
it('settles confirmed empty/partial pages consistently in reservations and launches while preserving reservation history and other providers',async()=>{
 const {db,store,jid}=await setup();try{
 await operation(db,jid,8,0);await operation(db,jid,8,2);await operation(db,jid,2,2,'succeeded',2,'apollo');
 const before=(await db.query('select * from public.provider_operations order by id')).rows;
 await db.exec("update public.provider_limits set free_units=18 where provider='explorium'");await login(db);await store.rpc('start_workflow',{p_organization:org,p_request:randomUUID()});const status:any=await store.rpc('operational_status',{});expect(status.explorium_units).toBe(2);expect(status.explorium_reserved_maxima).toBe(16);await db.exec('reset role');
 const job=Job.parse(await store.rpc('claim_job',{p_worker:'fixture'})),args={p_job:job.id,p_token:job.attempt_token,p_key:'fixture-page',p_provider:'explorium',p_hash:'request',p_max:'0',p_units:8};
 const first:any=await store.rpc('reserve_operation',args);expect((await store.rpc('reserve_operation',args) as any).id).toBe(first.id);
 expect((await db.query('select * from public.provider_operations where id<>$1 order by id',[first.id])).rows).toEqual(before);
 await db.exec("update public.provider_limits set free_units=2 where provider='apollo'");await expect(store.rpc('reserve_operation',{...args,p_key:'apollo-at-cap',p_provider:'apollo',p_units:1})).rejects.toThrow('free_quota_unverified_or_exhausted');
 }finally{await db.close();}
});
it('holds unknown, ambiguous, malformed, inconsistent and excess charges at both launch and reservation without releasing their units',async()=>{
 const {db,store,jid}=await setup();try{
 await login(db);await store.rpc('start_workflow',{p_organization:org,p_request:randomUUID()});await db.exec('reset role');const job=Job.parse(await store.rpc('claim_job',{p_worker:'fixture'}));
 for(const [actual,state,responseActual] of [[null,'succeeded',null],[null,'ambiguous',null],[null,'dispatched',null],['zero','succeeded','zero'],[0.5,'succeeded',0.5],[0,'succeeded',2],[9,'succeeded',9]]){
 const id=await operation(db,jid,8,actual,state as string,responseActual);
 expect((await db.query<{n:number|null}>('select private.verified_explorium_units(o) n from public.provider_operations o where id=$1',[id])).rows[0].n).toBeNull();
 await expect(store.rpc('reserve_operation',{p_job:job.id,p_token:job.attempt_token,p_key:randomUUID(),p_provider:'explorium',p_hash:'h',p_max:'0',p_units:2})).rejects.toThrow('explorium_credit_accounting_hold');
 await db.exec("update public.jobs set status='done'");await login(db);await expect(store.rpc('start_workflow',{p_organization:org,p_request:randomUUID()})).rejects.toThrow('explorium_credit_accounting_hold');await db.exec('reset role');
 await db.query("update public.jobs set status='running',lease_until=now()+interval '5 minutes' where id=$1",[job.id]);await db.query('delete from public.provider_operations where id=$1',[id]);
 }
 }finally{await db.close();}
});

it('raises the cumulative ceiling to three dollars without releasing holds or changing provider credits, and refuses unsafe recovery',async()=>{
 const {db,store,jid}=await setup();try{
 await db.exec(await readFile('supabase/recovery/016_three_dollar_501_intent_test.sql','utf8'));
 await db.query("insert into public.provider_operations(organization_id,job_id,campaign_id,operation_key,provider,request_hash,state,reserved_usd,actual_usd,units) values($1,$2,$3,'saved-hold','openai','h','ambiguous',0.10,null,0)",[org,jid,campaign]);
 const ops=(await db.query('select * from public.provider_operations order by id')).rows,limits=(await db.query("select provider,free_units,expires_at from public.provider_limits order by provider")).rows;
 await db.exec(await readFile(migration,'utf8'));
 expect((await db.query('select * from public.provider_operations order by id')).rows).toEqual(ops);
 expect((await db.query('select provider,free_units,expires_at from public.provider_limits order by provider')).rows).toEqual(limits);
 expect((await db.query<{cap:string}>('select limit_usd::text cap from public.budget')).rows[0].cap).toBe('3.00000000');
 await expect(db.exec('update public.budget set limit_usd=3.01')).rejects.toThrow('budget_limit_usd_check');
 await db.query("update public.provider_operations set actual_usd=2.40,reserved_usd=2.40 where operation_key='openai'");
 await login(db);await expect(store.rpc('start_workflow',{p_organization:org,p_request:randomUUID()})).resolves.toHaveProperty('created',true);await db.exec('reset role');
 await expect(db.exec(await readFile('supabase/recovery/016_three_dollar_501_intent_test.sql','utf8'))).rejects.toThrow('recovery_cap_below_preserved_commitments');await db.exec('rollback');
 await db.exec("update public.jobs set status='done';update public.provider_operations set reserved_usd=0.59 where operation_key='saved-hold'");
 await login(db);await expect(store.rpc('start_workflow',{p_organization:org,p_request:randomUUID()})).rejects.toThrow('budget_paused');await db.exec('reset role');
 }finally{await db.close();}
});
