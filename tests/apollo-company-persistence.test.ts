import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {testDatabase,seed,localStore,org,user,otherUser,campaign,enqueue} from './database';
import {Job} from '../src/contracts/pipeline';
import {hash} from '../src/domain/policy';
import {focusedProfile} from '../src/domain/focused-discovery';
const migration='supabase/migrations/20260907143733_apollo_company_discovery.sql';
async function setup(){const db=await testDatabase();await seed(db);for(const file of ['20260906154157_complementary_discovery.sql','20260907133534_review_workflow.sql','20260907135634_focused_query_calibration.sql','20260907143733_apollo_company_discovery.sql'])await db.exec(await readFile('supabase/migrations/'+file,'utf8'));return {db,store:localStore(db)};}
function candidate(id:string,name=id,domain=id+'.example.com'){return {source:'apollo',title:name,eventKey:hash(['apollo_company',id]),url:'https://'+domain,providerCompany:{provider:'apollo',id,name,domain,observedAt:'2026-09-07T00:00:00Z',icp:{status:'match'}}};}
it('ingests five companies, researches three, deduplicates across runs and preserves separate companies/history',async()=>{
 const {db,store}=await setup();try{
 expect((await db.query<{profile:unknown}>('select profile from public.workflow_profiles')).rows[0].profile).toEqual(focusedProfile);
 async function ingest(cid:string,rows:unknown[],maxResearch=3){await db.query("insert into public.jobs(organization_id,campaign_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload) values($1,$2,$3,'S02','h',7,'1','12','{}')",[org,cid,randomUUID()]);const job=Job.parse(await store.rpc('claim_job',{p_worker:'fixture'}));const args={p_job:job.id,p_token:job.attempt_token,p_candidates:rows,p_report:{maxResearch,mode:'fixture'}};expect(await store.rpc('ingest_company_discovery',args)).toBe(true);expect(await store.rpc('ingest_company_discovery',args)).toBe(true);return job;}
 const rows=['a','b','c','d','e'].map(id=>candidate(id));await ingest(campaign,rows);
 expect((await db.query("select * from public.jobs where stage='S04'")).rows).toHaveLength(3);
 const before=(await db.query<{id:string;packet:unknown}>('select id,packet from public.opportunities order by id')).rows;
 await db.exec("update public.jobs set status='done' where stage='S04'");const cid=randomUUID();await db.query("insert into public.campaigns(id,organization_id,name,profile,paused) values($1,$2,'Second','{}',false)",[cid,org]);
 await ingest(cid,[rows[0],candidate('a-new','a','a.example.com'),candidate('subsidiary','Different company','a.example.com')]);
 expect((await db.query('select * from public.company_discovery_observations')).rows).toHaveLength(8);
 expect((await db.query('select * from public.opportunities')).rows).toHaveLength(before.length+1);
 for(const prior of before)expect((await db.query('select id,packet from public.opportunities where id=$1',[prior.id])).rows[0]).toEqual(prior);
 await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${otherUser}',false)`);expect((await db.query('select * from public.company_discovery_observations')).rows).toHaveLength(0);await expect(store.rpc('ingest_company_discovery',{p_job:randomUUID(),p_token:randomUUID(),p_candidates:[],p_report:{}})).rejects.toThrow('permission');
 await db.exec('reset role');await db.exec(await readFile('supabase/recovery/011_apollo_company_discovery.sql','utf8'));expect((await db.query('select * from public.company_discovery_observations')).rows).toHaveLength(8);
 }finally{await db.close();}
});
it('launches only one Apollo page, checks allowance without spending, and retains duplicate-launch protection and unknown charges',async()=>{
 const {db,store}=await setup();try{
 await db.exec("update public.budget set live_enabled=true;update public.provider_limits set verified_at=now(),probe_enabled=true,free_units=case when provider='apollo' then 75 else 0 end where provider in('openai','brave','apollo')");
 const jid=await enqueue(db);await db.exec("update public.jobs set status='done'");
 for(const provider of ['openai','brave'])await db.query("insert into public.provider_operations(organization_id,job_id,campaign_id,operation_key,provider,request_hash,state,reserved_usd,actual_usd,units) values($1,$4,$2,$3,$3,'h','succeeded',0.01,0.01,0)",[org,campaign,provider,jid]);
 await db.query("insert into public.provider_operations(organization_id,job_id,campaign_id,operation_key,provider,request_hash,state,reserved_usd,units) values($1,$2,$3,'held','openai','h','ambiguous',0.08,0)",[org,jid,campaign]);
 const operationsBefore=(await db.query('select * from public.provider_operations order by operation_key')).rows;
 await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${user}',false)`);
 const args={p_organization:org,p_request:randomUUID()},run=await store.rpc('start_workflow',args) as {id:string};expect((await store.rpc('start_workflow',{...args,p_request:randomUUID()}) as {id:string}).id).toBe(run.id);
 await db.exec('reset role');const jobs=(await db.query<{payload:any}>("select payload from public.jobs where stage='S02'")).rows;expect(jobs).toHaveLength(1);expect(jobs[0].payload.groups[0]).toMatchObject({source:'apollo',page:1});expect(jobs[0].payload.maxResearch).toBe(3);
 expect((await db.query('select * from public.provider_operations order by operation_key')).rows).toEqual(operationsBefore);
 await db.exec("update public.jobs set status='done';update public.provider_limits set free_units=0 where provider='apollo'");
 await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${user}',false)`);await expect(store.rpc('start_workflow',{...args,p_request:randomUUID()})).rejects.toThrow('provider_unverified');
 await db.exec('reset role');
 await db.exec("update public.jobs set status='queued' where stage='S02'");
 await db.exec(await readFile('supabase/recovery/011_apollo_company_discovery.sql','utf8'));
 expect((await db.query("select * from public.jobs where stage='S02' and status='queued'")).rows).toHaveLength(0);
 expect((await db.query("select * from public.campaigns where profile->>'version'='7' and paused")).rows).toHaveLength(1);
 expect((await db.query('select * from public.provider_operations order by operation_key')).rows).toEqual(operationsBefore);
 }finally{await db.close();}
});
