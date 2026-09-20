import {it,expect} from 'vitest';
import type {PGlite} from '@electric-sql/pglite';
import {migratedDatabase,asUser,org,otherOrg,user,otherUser,campaign} from './database';

const A='40000000-0000-4000-8000-0000000000a1',B='40000000-0000-4000-8000-0000000000b1';
// complete_job persists each evidence row by its id, so fixtures use real UUIDs.
const E1='60000000-0000-4000-8000-0000000000e1';
const foreignCampaign='30000000-0000-4000-8000-0000000000f1',foreignOpp='40000000-0000-4000-8000-0000000000f2';

async function seedSelected(db:PGlite){
 await db.query(`insert into auth.users values($1,'reviewer@example.invalid'),($2,'other@example.invalid')`,[user,otherUser]);
 await db.query(`insert into public.organizations(id,name) values($1,'Fixture company'),($2,'Other tenant')`,[org,otherOrg]);
 await db.query(`insert into public.memberships values($1,$2,'admin'),($3,$4,'admin')`,[org,user,otherOrg,otherUser]);
 await db.query(`insert into public.campaigns(id,organization_id,name,profile,paused) values($1,$2,'Selected cohort','{}',false)`,[campaign,org]);
 await db.query(`insert into public.campaigns(id,organization_id,name,profile,paused) values($1,$2,'Other tenant campaign','{}',false)`,[foreignCampaign,otherOrg]);
 // A researched company (goes to S06) and one without evidence (goes to S04).
 await db.query(`insert into public.opportunities(id,organization_id,campaign_id,event_key,packet,state) values
  ($1,$2,$3,'a','{"mode":"live","state":"review_ready","evidence":[{"id":"60000000-0000-4000-8000-0000000000e1"}]}','review_ready'),
  ($4,$2,$3,'b','{"mode":"live","state":"company_context_pending","evidence":[]}','company_context_pending')`,[A,org,campaign,B]);
 await db.query(`insert into public.opportunities(id,organization_id,campaign_id,event_key,packet,state) values($1,$2,$3,'f','{"mode":"live","state":"review_ready","evidence":[{"id":"60000000-0000-4000-8000-0000000000ff"}]}','review_ready')`,[foreignOpp,otherOrg,foreignCampaign]);
 await db.query(`update public.budget set live_enabled=true,dollar_limits_enabled=false where id=1`);
 await db.query(`update public.provider_limits set verified_at=now(),probe_enabled=true where provider in('openai','brave')`);
}

const launch=(db:PGlite,request:string,ids:string[]=[A,B],o=org)=>
 db.query<{value:any}>(`select public.start_selected_workflow(p_organization=>$1,p_opportunities=>$2::uuid[],p_request=>$3) as value`,[o,ids,request]);

it('launches a selected run as an authenticated member, queues the right entry stage, and is idempotent',async()=>{
 const db=await migratedDatabase();await seedSelected(db);
 const key='50000000-0000-4000-8000-000000000001';
 const first=await asUser(db,user,()=>launch(db,key));
 expect(first.rows[0].value.created).toBe(true);
 expect(first.rows[0].value.queued).toBe(2);
 const runId=first.rows[0].value.id;

 // Entry stage follows the packet, not a hard-coded company.
 const jobs=await db.query<{stage:string;opportunity_id:string;run_id:string;input_version:number}>(
  `select stage,opportunity_id,run_id,input_version from public.jobs where run_id=$1 order by stage`,[runId]);
 expect(jobs.rows.map(j=>j.stage)).toEqual(['S04','S06']);
 expect(jobs.rows.every(j=>j.run_id===runId)).toBe(true);

 // entry_revision is the POST-launch revision, so launch alone cannot look like production.
 const members=await db.query<{entry_revision:number;result_revision:number|null;opportunity_id:string}>(
  `select entry_revision,result_revision,opportunity_id from public.workflow_run_members where run_id=$1`,[runId]);
 const opp=await db.query<{revision:number}>(`select revision from public.opportunities where id=$1`,[A]);
 expect(members.rows.find(m=>m.opportunity_id===A)!.entry_revision).toBe(opp.rows[0].revision);
 expect(members.rows.every(m=>m.result_revision===null)).toBe(true);

 // The same request key resolves to the same run and queues nothing further.
 const repeat=await asUser(db,user,()=>launch(db,key));
 expect(repeat.rows[0].value.created).toBe(false);
 expect(repeat.rows[0].value.id).toBe(runId);
 expect((await db.query(`select count(*)::int as n from public.jobs where run_id=$1`,[runId])).rows[0]).toEqual({n:2});

 // A different key while work is pending resumes the same run rather than starting a second one.
 const other=await asUser(db,user,()=>launch(db,'50000000-0000-4000-8000-000000000002'));
 expect(other.rows[0].value.created).toBe(false);
 expect(other.rows[0].value.id).toBe(runId);
});

it('refuses cross-organization and unauthenticated launches',async()=>{
 const db=await migratedDatabase();await seedSelected(db);
 await expect(launch(db,'50000000-0000-4000-8000-000000000010')).rejects.toThrow(/membership_required/);
 await expect(asUser(db,otherUser,()=>launch(db,'50000000-0000-4000-8000-000000000011')))
  .rejects.toThrow(/membership_required/);
 // A member of this organization cannot pull another tenant's company into their run.
 const mixed=await asUser(db,user,()=>launch(db,'50000000-0000-4000-8000-000000000012',[A,foreignOpp]));
 expect(mixed.rows[0].value.queued).toBe(1);
 expect(JSON.stringify(mixed.rows[0].value.skipped)).toContain('not_in_organization');
});

it('holds a company with an unresolved operation and lets the others run',async()=>{
 const db=await migratedDatabase();await seedSelected(db);
 const held=(await db.query<{id:string}>(`insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
  values($1,$2,$3,'prior','S06','h',1,'1','1','{}') returning id`,[org,campaign,A])).rows[0].id;
 // Succeeded but with unknown cost: still unresolved, so this member stays out.
 await db.query(`insert into public.provider_operations(organization_id,job_id,campaign_id,opportunity_id,operation_key,provider,request_hash,reserved_usd,units,state,actual_usd)
  values($1,$2,$3,$4,'k','openai','h',0.01,0,'succeeded',null)`,[org,held,campaign,A]);
 await db.query(`update public.jobs set status='done' where id=$1`,[held]);
 const run=await asUser(db,user,()=>launch(db,'50000000-0000-4000-8000-000000000020'));
 expect(run.rows[0].value.queued).toBe(1);
 expect(JSON.stringify(run.rows[0].value.skipped)).toContain('unresolved_dispatch_held');
 expect((await db.query(`select opportunity_id from public.jobs where run_id=$1`,[run.rows[0].value.id])).rows)
  .toEqual([{opportunity_id:B}]);
});

it('propagates run ownership to child jobs and records the result this run produced',async()=>{
 const db=await migratedDatabase();await seedSelected(db);
 const run=(await asUser(db,user,()=>launch(db,'50000000-0000-4000-8000-000000000030',[A]))).rows[0].value;
 const job=(await db.query<{id:string;input_version:number}>(`select id,input_version from public.jobs where run_id=$1`,[run.id])).rows[0];
 const token=(await db.query<{attempt_token:string}>(
  `update public.jobs set status='running',attempt_token=gen_random_uuid(),lease_until=now()+interval '90 seconds' where id=$1 returning attempt_token`,[job.id])).rows[0].attempt_token;

 const output={mode:'live',state:'researched',evidence:[{id:E1}],research:{decision:'exploration'}};
 const next={business_key:'child',stage:'S08',input_hash:'child-hash'};
 const done=await db.query<{value:boolean}>(`select public.complete_job($1,$2,$3::jsonb,$4::jsonb) as value`,
  [job.id,token,JSON.stringify(output),JSON.stringify(next)]);
 expect(done.rows[0].value).toBe(true);

 // The child job inherits the run through complete_job_pre_kvd101, the function that owns the INSERT.
 const child=await db.query<{stage:string;run_id:string}>(`select stage,run_id from public.jobs where business_key='child'`);
 expect(child.rows[0]).toEqual({stage:'S08',run_id:run.id});

 // The trigger snapshots what this run produced.
 const member=(await db.query<{result_revision:number;result_state:string;last_completed_stage:string;result_packet:any}>(
  `select result_revision,result_state,last_completed_stage,result_packet from public.workflow_run_members where run_id=$1`,[run.id])).rows[0];
 expect(member.last_completed_stage).toBe('S06');
 expect(member.result_state).toBe('researched');
 expect(member.result_packet.research.decision).toBe('exploration');

 // A LATER change to the same opportunity must not rewrite this run's recorded result.
 await db.query(`update public.opportunities set packet=$2::jsonb,state='review_ready',revision=revision+5 where id=$1`,
  [A,JSON.stringify({mode:'live',state:'review_ready',evidence:[],research:{decision:'priority'}})]);
 const status=(await asUser(db,user,()=>db.query<{value:any}>(
  `select public.selected_run_status(p_organization=>$1,p_run=>$2) as value`,[org,run.id]))).rows[0].value;
 const reported=status.members[0];
 expect(reported.packet.research.decision).toBe('exploration');
 expect(reported.state).toBe('researched');
 expect(reported.resultRevision).toBe(member.result_revision);
 expect(reported.currentRevision).toBeGreaterThan(member.result_revision);
});

it('stops new paid work when the run expires but still settles a returned response',async()=>{
 const db=await migratedDatabase();await seedSelected(db);
 const run=(await asUser(db,user,()=>launch(db,'50000000-0000-4000-8000-000000000040',[A]))).rows[0].value;
 const job=(await db.query<{id:string}>(`select id from public.jobs where run_id=$1`,[run.id])).rows[0].id;
 const token=(await db.query<{attempt_token:string}>(
  `update public.jobs set status='running',attempt_token=gen_random_uuid(),lease_until=now()+interval '90 seconds' where id=$1 returning attempt_token`,[job])).rows[0].attempt_token;

 // Reserve while the run is live, then let the run expire before dispatch.
 const reserved=await db.query<{value:any}>(`select public.reserve_operation($1,$2,'k1','openai','h1',0.01,0) as value`,[job,token]);
 expect(reserved.rows[0].value.state).toBe('reserved');
 await db.query(`update public.workflow_runs set expires_at=now()-interval '1 minute' where id=$1`,[run.id]);

 await expect(db.query(`select public.dispatch_operation($1,$2,$3) as value`,[reserved.rows[0].value.id,job,token]))
  .rejects.toThrow(/run_expired_or_stopped/);
 await expect(db.query(`select public.reserve_operation($1,$2,'k2','openai','h2',0.01,0) as value`,[job,token]))
  .rejects.toThrow(/run_expired_or_stopped/);

 // A response that already returned still settles: accounting is never lost to an expiry.
 await db.query(`update public.provider_operations set state='dispatched',dispatched_at=now() where id=$1`,[reserved.rows[0].value.id]);
 const settled=await db.query<{value:boolean}>(`select public.record_operation($1,'h1','{"ok":true}'::jsonb,'{}'::jsonb,0.009) as value`,[reserved.rows[0].value.id]);
 expect(settled.rows[0].value).toBe(true);
 expect((await db.query<{state:string;actual_usd:string}>(`select state,actual_usd from public.provider_operations where id=$1`,[reserved.rows[0].value.id])).rows[0].state).toBe('succeeded');
});

it('authorizes Apollo for this run\'s member and refuses an unrelated historical job',async()=>{
 const db=await migratedDatabase();await seedSelected(db);
 const run=(await asUser(db,user,()=>launch(db,'50000000-0000-4000-8000-000000000050',[A]))).rows[0].value;
 await db.query(`update public.provider_limits set verified_at=now(),probe_enabled=true,free_units=75,expires_at=now()-interval '1 day',
  evidence='{"kind":"user_confirmed_free_allowance"}' where provider='apollo'`);

 // A member's S10 job inside this run is authorized by the campaign window plus run membership.
 const mine=(await db.query<{id:string}>(`insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload,run_id)
  select $1,$2,$3,'s10-mine','S10','h',revision,'1','1','{}',$4 from public.opportunities where id=$3 returning id`,[org,campaign,A,run.id])).rows[0].id;
 const mineToken=(await db.query<{attempt_token:string}>(`update public.jobs set status='running',attempt_token=gen_random_uuid(),lease_until=now()+interval '90 seconds' where id=$1 returning attempt_token`,[mine])).rows[0].attempt_token;
 const ok=await db.query<{value:any}>(`select public.reserve_operation($1,$2,'contact','apollo','ch',0,1) as value`,[mine,mineToken]);
 expect(ok.rows[0].value.state).toBe('reserved');

 // A historical S10 job with no run must NOT ride this run's window: it is not a discovery run.
 const legacy=(await db.query<{id:string}>(`insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
  select $1,$2,$3,'s10-legacy','S10','h',revision,'1','1','{}' from public.opportunities where id=$3 returning id`,[org,campaign,A])).rows[0].id;
 const legacyToken=(await db.query<{attempt_token:string}>(`update public.jobs set status='running',attempt_token=gen_random_uuid(),lease_until=now()+interval '90 seconds' where id=$1 returning attempt_token`,[legacy])).rows[0].attempt_token;
 await expect(db.query(`select public.reserve_operation($1,$2,'contact2','apollo','ch2',0,1) as value`,[legacy,legacyToken]))
  .rejects.toThrow(/provider_unverified/);
});

it('keeps the discovery contact path working for a discovery run',async()=>{
 const db=await migratedDatabase();await seedSelected(db);
 await db.query(`update public.provider_limits set verified_at=now(),probe_enabled=true,free_units=75,expires_at=now()-interval '1 day',
  evidence='{"kind":"user_confirmed_free_allowance"}' where provider='apollo'`);
 await db.query(`update public.campaigns set profile=jsonb_set(profile,'{contactExecutionExpiresAt}',to_jsonb(now()+interval '1 hour')) where id=$1`,[campaign]);
 await db.query(`insert into public.workflow_runs(organization_id,campaign_id,request_key,requested_by,mode)
  values($1,$2,gen_random_uuid(),$3,'discovery')`,[org,campaign,user]);
 const job=(await db.query<{id:string}>(`insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
  select $1,$2,$3,'discovery-s10','S10','h',revision,'1','1','{}' from public.opportunities where id=$3 returning id`,[org,campaign,A])).rows[0].id;
 const token=(await db.query<{attempt_token:string}>(`update public.jobs set status='running',attempt_token=gen_random_uuid(),lease_until=now()+interval '90 seconds' where id=$1 returning attempt_token`,[job])).rows[0].attempt_token;
 const ok=await db.query<{value:any}>(`select public.reserve_operation($1,$2,'contact','apollo','ch',0,1) as value`,[job,token]);
 expect(ok.rows[0].value.state).toBe('reserved');
});

it('recovers fully before any selected run exists',async()=>{
 const db=await migratedDatabase();await seedSelected(db);
 const rollback=await (await import('node:fs/promises')).readFile('supabase/recovery/022_selected_company_runs_rollback.sql','utf8');
 await db.exec(rollback);
 // The schema is back to its pre-migration shape, uniqueness included.
 expect((await db.query<{n:number}>(`select count(*)::int as n from information_schema.columns where table_name='jobs' and column_name='run_id'`)).rows[0].n).toBe(0);
 expect((await db.query<{n:number}>(`select count(*)::int as n from pg_constraint where conname='workflow_runs_campaign_id_key'`)).rows[0].n).toBe(1);
 // And an ordinary job still reserves.
 const job=(await db.query<{id:string}>(`insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
  select $1,$2,$3,'after-rollback','S06','h',revision,'1','1','{}' from public.opportunities where id=$3 returning id`,[org,campaign,A])).rows[0].id;
 const token=(await db.query<{attempt_token:string}>(`update public.jobs set status='running',attempt_token=gen_random_uuid(),lease_until=now()+interval '90 seconds' where id=$1 returning attempt_token`,[job])).rows[0].attempt_token;
 expect((await db.query<{value:any}>(`select public.reserve_operation($1,$2,'after','openai','h',0.01,0) as value`,[job,token])).rows[0].value.state).toBe('reserved');
});

it('refuses to recover while a selected run is still working',async()=>{
 const db=await migratedDatabase();await seedSelected(db);
 await asUser(db,user,()=>launch(db,'50000000-0000-4000-8000-000000000070',[A]));
 const rollback=await (await import('node:fs/promises')).readFile('supabase/recovery/022_selected_company_runs_rollback.sql','utf8');
 await expect(db.exec(rollback)).rejects.toThrow(/selected_run_still_active/);
 // The failed recovery left its transaction open; end it and confirm nothing was half-applied.
 await db.exec('rollback');
 expect((await db.query<{n:number}>(`select count(*)::int as n from information_schema.routines where routine_name='start_selected_workflow'`)).rows[0].n).toBe(2);
 expect((await db.query<{n:number}>(`select count(*)::int as n from information_schema.columns where table_name='jobs' and column_name='run_id'`)).rows[0].n).toBe(1);
});

it('recovers behaviour without deleting history when a campaign holds several runs',async()=>{
 const db=await migratedDatabase();await seedSelected(db);
 const first=(await asUser(db,user,()=>launch(db,'50000000-0000-4000-8000-000000000060',[A]))).rows[0].value;
 await db.query(`update public.jobs set status='done' where run_id=$1`,[first.id]);
 // A second selected run on the same campaign is exactly what this migration enables.
 const second=(await asUser(db,user,()=>launch(db,'50000000-0000-4000-8000-000000000061',[A]))).rows[0].value;
 expect(second.created).toBe(true);
 expect(second.id).not.toBe(first.id);
 await db.query(`update public.jobs set status='done' where run_id=$1`,[second.id]);

 const rollback=await (await import('node:fs/promises')).readFile('supabase/recovery/022_selected_company_runs_rollback.sql','utf8');
 await db.exec(rollback);

 // History survives in full, and uniqueness is deliberately NOT restored by deleting runs.
 expect((await db.query<{n:number}>(`select count(*)::int as n from public.workflow_runs where campaign_id=$1`,[campaign])).rows[0].n).toBe(2);
 expect((await db.query<{n:number}>(`select count(*)::int as n from public.workflow_run_members`)).rows[0].n).toBe(2);
 expect((await db.query<{n:number}>(`select count(*)::int as n from pg_constraint where conname='workflow_runs_campaign_id_key'`)).rows[0].n).toBe(0);
 // The selected-run behaviour is gone.
 expect((await db.query<{n:number}>(`select count(*)::int as n from information_schema.routines where routine_name='start_selected_workflow'`)).rows[0].n).toBe(0);
 // reserve_operation works again for an ordinary job.
 const job=(await db.query<{id:string}>(`insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
  select $1,$2,$3,'after-rollback','S06','h',revision,'1','1','{}' from public.opportunities where id=$3 returning id`,[org,campaign,A])).rows[0].id;
 const token=(await db.query<{attempt_token:string}>(`update public.jobs set status='running',attempt_token=gen_random_uuid(),lease_until=now()+interval '90 seconds' where id=$1 returning attempt_token`,[job])).rows[0].attempt_token;
 expect((await db.query<{value:any}>(`select public.reserve_operation($1,$2,'after','openai','h',0.01,0) as value`,[job,token])).rows[0].value.state).toBe('reserved');
});

const secondCampaign='30000000-0000-4000-8000-0000000000c2',C='40000000-0000-4000-8000-0000000000c3';
async function seedSecondCampaign(db:PGlite){
 await db.query(`insert into public.campaigns(id,organization_id,name,profile,paused) values($1,$2,'Other saved campaign','{}',false)`,[secondCampaign,org]);
 await db.query(`insert into public.opportunities(id,organization_id,campaign_id,event_key,packet,state) values($1,$2,$3,'c','{"mode":"live","state":"review_ready","evidence":[{"id":"60000000-0000-4000-8000-0000000000e2"}]}','review_ready')`,[C,org,secondCampaign]);
}

it('runs one cohort across several source campaigns without reparenting any company',async()=>{
 const db=await migratedDatabase();await seedSelected(db);await seedSecondCampaign(db);
 const run=(await asUser(db,user,()=>launch(db,'50000000-0000-4000-8000-000000000080',[A,C]))).rows[0].value;
 expect(run.created).toBe(true);
 expect(run.queued).toBe(2);
 // One run, one request, two originating campaigns.
 expect(new Set(run.campaigns)).toEqual(new Set([campaign,secondCampaign]));

 // Each job keeps its own company's campaign; nothing was moved into the run's campaign.
 const jobs=await db.query<{opportunity_id:string;campaign_id:string;run_id:string}>(
  `select opportunity_id,campaign_id,run_id from public.jobs where run_id=$1 order by opportunity_id`,[run.id]);
 expect(jobs.rows.find(j=>j.opportunity_id===A)!.campaign_id).toBe(campaign);
 expect(jobs.rows.find(j=>j.opportunity_id===C)!.campaign_id).toBe(secondCampaign);
 expect(jobs.rows.every(j=>j.run_id===run.id)).toBe(true);
 // The opportunities themselves are untouched.
 const owners=await db.query<{id:string;campaign_id:string}>(`select id,campaign_id from public.opportunities where id=any($1::uuid[])`,[[A,C]]);
 expect(owners.rows.find(o=>o.id===A)!.campaign_id).toBe(campaign);
 expect(owners.rows.find(o=>o.id===C)!.campaign_id).toBe(secondCampaign);

 // Apollo is authorized for a member in the NON-owning campaign, from the run's own window.
 await db.query(`update public.provider_limits set verified_at=now(),probe_enabled=true,free_units=75,expires_at=now()-interval '1 day',
  evidence='{"kind":"user_confirmed_free_allowance"}' where provider='apollo'`);
 const s10=(await db.query<{id:string}>(`insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload,run_id)
  select $1,$2,$3,'s10-cross','S10','h',revision,'1','1','{}',$4 from public.opportunities where id=$3 returning id`,[org,secondCampaign,C,run.id])).rows[0].id;
 const token=(await db.query<{attempt_token:string}>(`update public.jobs set status='running',attempt_token=gen_random_uuid(),lease_until=now()+interval '90 seconds' where id=$1 returning attempt_token`,[s10])).rows[0].attempt_token;
 expect((await db.query<{value:any}>(`select public.reserve_operation($1,$2,'contact','apollo','ch',0,1) as value`,[s10,token])).rows[0].value.state).toBe('reserved');
});

it('never revives a legacy discovery contact job through a selected launch',async()=>{
 const db=await migratedDatabase();await seedSelected(db);
 await db.query(`update public.provider_limits set verified_at=now(),probe_enabled=true,free_units=75,expires_at=now()-interval '1 day',
  evidence='{"kind":"user_confirmed_free_allowance"}' where provider='apollo'`);
 // A real discovery run on the SAME campaign whose contact authority has already expired.
 await db.query(`insert into public.workflow_runs(organization_id,campaign_id,request_key,requested_by,mode)
  values($1,$2,gen_random_uuid(),$3,'discovery')`,[org,campaign,user]);
 await db.query(`update public.campaigns set profile=jsonb_set(profile,'{contactExecutionExpiresAt}',to_jsonb(now()-interval '1 hour')) where id=$1`,[campaign]);
 const legacy=(await db.query<{id:string}>(`insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
  select $1,$2,$3,'legacy-s10','S10','h',revision,'1','1','{}' from public.opportunities where id=$3 returning id`,[org,campaign,B])).rows[0].id;

 // Now a selected run starts on the same campaign.
 const run=(await asUser(db,user,()=>launch(db,'50000000-0000-4000-8000-000000000090',[A]))).rows[0].value;
 expect(run.created).toBe(true);
 // The discovery deadline is untouched: the launcher writes no campaign profile at all.
 const profile=(await db.query<{expiry:string}>(`select profile->>'contactExecutionExpiresAt' as expiry from public.campaigns where id=$1`,[campaign])).rows[0];
 expect(Date.parse(profile.expiry)).toBeLessThan(Date.now());

 // The unselected legacy job stays refused.
 const legacyToken=(await db.query<{attempt_token:string}>(`update public.jobs set status='running',attempt_token=gen_random_uuid(),lease_until=now()+interval '90 seconds' where id=$1 returning attempt_token`,[legacy])).rows[0].attempt_token;
 await expect(db.query(`select public.reserve_operation($1,$2,'contact','apollo','ch',0,1) as value`,[legacy,legacyToken]))
  .rejects.toThrow(/provider_unverified/);

 // The selected run's own member is authorized from the run window.
 const mine=(await db.query<{id:string}>(`insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload,run_id)
  select $1,$2,$3,'selected-s10','S10','h',revision,'1','1','{}',$4 from public.opportunities where id=$3 returning id`,[org,campaign,A,run.id])).rows[0].id;
 const mineToken=(await db.query<{attempt_token:string}>(`update public.jobs set status='running',attempt_token=gen_random_uuid(),lease_until=now()+interval '90 seconds' where id=$1 returning attempt_token`,[mine])).rows[0].attempt_token;
 expect((await db.query<{value:any}>(`select public.reserve_operation($1,$2,'contact2','apollo','ch2',0,1) as value`,[mine,mineToken])).rows[0].value.state).toBe('reserved');
});

it('preserves history after exactly one completed selected run',async()=>{
 const db=await migratedDatabase();await seedSelected(db);
 const run=(await asUser(db,user,()=>launch(db,'50000000-0000-4000-8000-0000000000a0',[A]))).rows[0].value;
 await db.query(`update public.jobs set status='done' where run_id=$1`,[run.id]);
 // Exactly one run on this campaign: duplicated=0, but its history is the only record that it ran.
 expect((await db.query<{n:number}>(`select count(*)::int as n from public.workflow_runs where campaign_id=$1`,[campaign])).rows[0].n).toBe(1);

 const rollback=await (await import('node:fs/promises')).readFile('supabase/recovery/022_selected_company_runs_rollback.sql','utf8');
 await db.exec(rollback);

 // BEHAVIOUR recovery: the run, its membership and jobs.run_id all survive.
 expect((await db.query<{n:number}>(`select count(*)::int as n from public.workflow_run_members where run_id=$1`,[run.id])).rows[0].n).toBe(1);
 expect((await db.query<{n:number}>(`select count(*)::int as n from information_schema.columns where table_name='jobs' and column_name='run_id'`)).rows[0].n).toBe(1);
 expect((await db.query<{n:number}>(`select count(*)::int as n from public.jobs where run_id=$1`,[run.id])).rows[0].n).toBeGreaterThan(0);
 // The behaviour is still reverted.
 expect((await db.query<{n:number}>(`select count(*)::int as n from information_schema.routines where routine_name='start_selected_workflow'`)).rows[0].n).toBe(0);
});
