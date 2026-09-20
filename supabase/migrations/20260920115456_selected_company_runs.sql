-- Selected-company runs: a normal Run Workflow over chosen accounts in an existing campaign.
--
-- APPLIED to project zosoeeamvpfendsphnjn and recorded by Supabase as version 20260920115456.
-- The business SQL below is byte-identical to what was applied (sha256
-- 8cb49596283e0d639ad39d65e530640a62082fd4e0ab6279ef254f9e4626abd4). Do not apply it again; the
-- migration history belongs to Supabase. To reverse it, use
-- supabase/recovery/022_selected_company_runs_rollback.sql.
--
-- THIS IS NOT AN ADDITIVE-ONLY CHANGE. It:
--   * DROPS the workflow_runs.campaign_id UNIQUE constraint and replaces it with a partial unique
--     index, so a campaign may hold one discovery run plus any number of selected runs over time;
--   * REPLACES public.complete_job_pre_kvd101 and public.reserve_operation by text substitution on
--     their live definitions, each guarded so an unexpected body aborts the migration;
--   * MUTATES DATA at launch time: private.start_selected_workflow writes campaigns.profile and
--     updates opportunities (packet, state, revision) for every member it queues.
-- supabase/recovery/022_selected_company_runs_rollback.sql reverses the schema and function changes.
--
-- Discovery keeps its own launcher, provider gates and global expiry behaviour untouched.
-- No provider_limits row is written here; Apollo at S10 is authorized by run membership.

-- ---------------------------------------------------------------------------------------------
-- Run identity, finite authorization and membership
-- ---------------------------------------------------------------------------------------------
alter table public.workflow_runs add column if not exists mode text not null default 'discovery';
alter table public.workflow_runs add column if not exists status text not null default 'active';
alter table public.workflow_runs add column if not exists expires_at timestamptz;
do $m$ begin
 if not exists(select 1 from pg_constraint where conname='workflow_runs_mode_check') then
  alter table public.workflow_runs add constraint workflow_runs_mode_check check(mode in ('discovery','selected'));
 end if;
 if not exists(select 1 from pg_constraint where conname='workflow_runs_status_check') then
  alter table public.workflow_runs add constraint workflow_runs_status_check check(status in ('active','stopped'));
 end if;
end $m$;
-- Historical discovery runs keep their single-run-per-campaign guarantee.
alter table public.workflow_runs drop constraint if exists workflow_runs_campaign_id_key;
create unique index if not exists workflow_runs_one_discovery_per_campaign
 on public.workflow_runs(campaign_id) where mode='discovery';
create index if not exists workflow_runs_campaign_created on public.workflow_runs(campaign_id,created_at desc);

-- Membership records the revision the run STARTS at (post-launch) and, separately, the revision a
-- stage of this run actually completed. A later run cannot rewrite an earlier run's reported result.
create table if not exists public.workflow_run_members (
 run_id uuid not null references public.workflow_runs on delete cascade,
 organization_id uuid not null,
 opportunity_id uuid not null,
 entry_revision integer not null,
 entry_state text not null,
 queued_stage text not null,
 result_revision integer,
 result_packet_hash text,
 -- The packet exactly as this run produced it. A later run cannot rewrite what this run reported.
 result_packet jsonb,
 result_state text,
 last_completed_stage text,
 completed_at timestamptz,
 created_at timestamptz not null default now(),
 primary key(run_id,opportunity_id),
 foreign key(organization_id,opportunity_id) references public.opportunities(organization_id,id)
);
create index if not exists workflow_run_members_opportunity on public.workflow_run_members(organization_id,opportunity_id);
alter table public.workflow_run_members enable row level security;
revoke all on public.workflow_run_members from public,anon,authenticated;
grant select on public.workflow_run_members to authenticated;
grant all on public.workflow_run_members to service_role;
drop policy if exists member_read on public.workflow_run_members;
create policy member_read on public.workflow_run_members for select to authenticated
 using(organization_id in(select organization_id from public.memberships where user_id=(select auth.uid())));

-- Carry run ownership into jobs so status, counting and authorization are run-scoped.
alter table public.jobs add column if not exists run_id uuid references public.workflow_runs on delete set null;
create index if not exists jobs_run on public.jobs(run_id) where run_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Run ownership through the ACTUAL child-job insertion path
-- public.complete_job (KVD101) performs review allocation and then delegates; the INSERT lives in
-- public.complete_job_pre_kvd101. Patch that one and leave the allocation wrapper untouched.
-- ---------------------------------------------------------------------------------------------
do $carry$ declare definition text; before text; begin
 definition:=pg_get_functiondef('public.complete_job_pre_kvd101(uuid,uuid,jsonb,jsonb)'::regprocedure);
 before:='insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)';
 if position(before in definition)=0 then raise exception 'unexpected_complete_job_columns'; end if;
 definition:=replace(definition,before,
  'insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload,run_id)');
 before:='values(j.organization_id,j.campaign_id,j.opportunity_id,p_next->>''business_key'',p_next->>''stage'',p_next->>''input_hash'',j.input_version,j.schema_version,j.prompt_version,p_output)';
 if position(before in definition)=0 then raise exception 'unexpected_complete_job_values'; end if;
 definition:=replace(definition,before,
  'values(j.organization_id,j.campaign_id,j.opportunity_id,p_next->>''business_key'',p_next->>''stage'',p_next->>''input_hash'',j.input_version,j.schema_version,j.prompt_version,p_output,j.run_id)');
 execute definition;
end $carry$;

-- Record what this run actually completed, at the moment it completes, so attribution is immutable.
create or replace function private.record_run_result() returns trigger
 language plpgsql security definer set search_path='' as $$
begin
 if new.run_id is not null and new.opportunity_id is not null and new.status='done' and old.status is distinct from 'done' then
  update public.workflow_run_members m
  set result_revision=o.revision,result_packet_hash=o.packet_hash,result_packet=o.packet,result_state=o.state,
      last_completed_stage=new.stage,completed_at=now()
  from public.opportunities o
  where m.run_id=new.run_id and m.opportunity_id=new.opportunity_id and o.id=new.opportunity_id;
 end if;
 return new;
end $$;
drop trigger if exists jobs_record_run_result on public.jobs;
create trigger jobs_record_run_result after update on public.jobs
 for each row execute function private.record_run_result();

-- ---------------------------------------------------------------------------------------------
-- Reservation authorization bound to the run, not merely to the campaign
-- ---------------------------------------------------------------------------------------------
do $auth$ declare definition text; before text; after text; begin
 definition:=pg_get_functiondef('public.reserve_operation(uuid,uuid,text,text,text,numeric,integer)'::regprocedure);

 -- A job carrying a run stops buying new work once that run expires or is stopped. Operations that
 -- already returned are untouched; this only refuses NEW reservations.
 before:='if j.opportunity_id is not null and not exists(select 1 from public.opportunities where id=j.opportunity_id and revision=j.input_version) then raise exception ''stale_version''; end if;';
 if position(before in definition)=0 then raise exception 'unexpected_reserve_stale_version_guard'; end if;
 definition:=replace(definition,before,before||'
 if j.run_id is not null and not exists(select 1 from public.workflow_runs w where w.id=j.run_id and w.organization_id=j.organization_id and w.status=''active'' and (w.expires_at is null or w.expires_at>now()) and (w.mode<>''selected'' or exists(select 1 from public.workflow_run_members m where m.run_id=w.id and m.opportunity_id=j.opportunity_id))) then raise exception ''run_expired_or_stopped''; end if;');

 -- The campaign contact window must apply to THIS run's own members at S10, not to any historical
 -- job that happens to share the campaign.
 before:='or exists(select 1 from public.campaigns c join public.workflow_runs w on w.campaign_id=c.id where c.id=j.campaign_id and c.organization_id=j.organization_id and (c.profile->>''contactExecutionExpiresAt'')::timestamptz>now())';
 -- Two independent authorities that never lend each other time:
 --   * a SELECTED job is authorized by its own run's finite expires_at plus run membership. It does
 --     not read campaigns.profile at all, so a cohort may span source campaigns and a selected
 --     launch can never extend a discovery deadline.
 --   * a DISCOVERY job (run_id null) keeps exactly the campaign window it already had.
 after:='or exists(select 1 from public.workflow_runs w join public.workflow_run_members m on m.run_id=w.id where w.id=j.run_id and w.organization_id=j.organization_id and w.mode=''selected'' and w.status=''active'' and w.expires_at>now() and m.opportunity_id=j.opportunity_id) or (j.run_id is null and exists(select 1 from public.campaigns c join public.workflow_runs w on w.campaign_id=c.id where c.id=j.campaign_id and c.organization_id=j.organization_id and w.mode=''discovery'' and (c.profile->>''contactExecutionExpiresAt'')::timestamptz>now()))';
 if position(before in definition)=0 then raise exception 'unexpected_reserve_contact_window'; end if;
 definition:=replace(definition,before,after);
 execute definition;
end $auth$;

-- A reservation taken just before a run expired must not dispatch afterwards. Responses that have
-- already returned still settle through record_operation, which is deliberately left untouched.
do $dispatch$ declare definition text; before text; begin
 definition:=pg_get_functiondef('public.dispatch_operation(uuid,uuid,uuid)'::regprocedure);
 before:=' if not public.renew_job(p_job,p_token) then return false; end if;';
 if position(before in definition)=0 then raise exception 'unexpected_dispatch_definition'; end if;
 definition:=replace(definition,before,before||'
 if exists(select 1 from public.jobs j where j.id=p_job and j.run_id is not null and not exists(
   select 1 from public.workflow_runs w where w.id=j.run_id and w.organization_id=j.organization_id
   and w.status=''active'' and (w.expires_at is null or w.expires_at>now()))) then raise exception ''run_expired_or_stopped''; end if;');
 execute definition;
end $dispatch$;

-- ---------------------------------------------------------------------------------------------
-- Launch
-- ---------------------------------------------------------------------------------------------
create or replace function private.selected_entry_stage(p jsonb) returns text
 language sql immutable security invoker set search_path='' as $$
 select case when jsonb_array_length(coalesce(p->'evidence','[]'::jsonb))>0 then 'S06' else 'S04' end;
$$;

create or replace function private.start_selected_workflow(
 p_organization uuid, p_opportunities uuid[], p_request uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.workflow_runs; c public.campaigns; o public.opportunities; cap numeric; member uuid;
 entry text; queued integer:=0; skipped jsonb:='[]'::jsonb; snap jsonb; run_window timestamptz;
 owning uuid; campaigns_seen uuid[]:='{}';
begin
 if auth.uid() is null or not exists(select 1 from public.memberships where organization_id=p_organization and user_id=auth.uid())
  then raise exception 'membership_required'; end if;
 if p_request is null then raise exception 'request_required'; end if;
 if p_opportunities is null or array_length(p_opportunities,1) is null then raise exception 'selection_required'; end if;
 if array_length(p_opportunities,1)>25 then raise exception 'selection_too_large'; end if;

 perform 1 from public.organizations where id=p_organization for update;

 -- Same request key resolves to the same run. A repeat click never launches twice.
 select * into r from public.workflow_runs where organization_id=p_organization and request_key=p_request;
 if found then return to_jsonb(r)||jsonb_build_object('created',false,'queued',0); end if;

 -- The cohort may span source campaigns. Opportunities are never reparented: each keeps its own
 -- campaign, and the run records the first member's campaign purely as provenance.
 select o2.campaign_id into owning from public.opportunities o2
 where o2.id=any(p_opportunities) and o2.organization_id=p_organization
 order by array_position(p_opportunities,o2.id) limit 1;
 if owning is null then raise exception 'campaign_not_found'; end if;

 -- Any active selected run of this organization is resumed, not duplicated.
 select w.* into r from public.workflow_runs w
 where w.organization_id=p_organization and w.mode='selected' and w.status='active'
 and (w.expires_at is null or w.expires_at>now())
 and exists(select 1 from public.jobs j where j.run_id=w.id and j.status in('queued','running'))
 order by w.created_at desc limit 1;
 if found then return to_jsonb(r)||jsonb_build_object('created',false,'queued',0); end if;

 select limit_usd into cap from public.budget where id=1 and live_enabled for update;
 if cap is null then raise exception 'live_disabled'; end if;
 if (select dollar_limits_enabled from public.budget where id=1) then
  if (select coalesce(sum(coalesce(actual_usd,reserved_usd)),0) from public.provider_operations)+0.025>cap
   then raise exception 'budget_paused'; end if;
 end if;
 -- Only the providers a selected run actually uses. Explorium entitlement, trial dates and the
 -- discovery cursor are deliberately not consulted.
 if (select count(*) from public.provider_limits l where l.provider in('openai','brave')
     and l.verified_at is not null and (l.probe_enabled or (l.authenticated and l.usable)))<>2
  then raise exception 'provider_unverified'; end if;

 -- One finite window per authorized click, recorded on the run itself. No campaign profile is
 -- written, so a selected launch can never extend a discovery campaign's contact deadline.
 run_window:=now()+interval '4 hours';
 insert into public.workflow_runs(organization_id,campaign_id,request_key,requested_by,mode,status,expires_at)
 values(p_organization,owning,p_request,auth.uid(),'selected','active',run_window) returning * into r;

 foreach member in array p_opportunities loop
  select * into o from public.opportunities where id=member and organization_id=p_organization for update;
  if not found then
   skipped:=skipped||jsonb_build_object('opportunity',member,'reason','not_in_organization'); continue; end if;
  select * into c from public.campaigns where id=o.campaign_id and organization_id=p_organization;
  if not found or c.paused then
   skipped:=skipped||jsonb_build_object('opportunity',member,'reason','campaign_unavailable'); continue; end if;
  if not (o.campaign_id=any(campaigns_seen)) then campaigns_seen:=campaigns_seen||o.campaign_id; end if;
  if o.state in ('rejected','disqualified','relationship_handoff','icp_mismatch','service_mismatch') then
   skipped:=skipped||jsonb_build_object('opportunity',member,'reason','excluded:'||o.state); continue; end if;
  if exists(select 1 from public.jobs j where j.opportunity_id=o.id and j.status in('queued','running')) then
   skipped:=skipped||jsonb_build_object('opportunity',member,'reason','work_already_pending'); continue; end if;
  entry:=private.selected_entry_stage(o.packet);
  -- An uncertain DISPATCHED operation on the entry stage stays held. A plain reservation that was
  -- never dispatched is not the same thing and does not hold the company back.
  if exists(select 1 from public.provider_operations x join public.jobs j on j.id=x.job_id
            where x.opportunity_id=o.id and j.stage=entry
            and (x.state in('dispatched','ambiguous') or (x.state='succeeded' and x.actual_usd is null))) then
   skipped:=skipped||jsonb_build_object('opportunity',member,'reason','unresolved_dispatch_held'); continue; end if;

  -- New run, new version. The earlier packet stays in history; entry_revision is the revision this
  -- run STARTS at, so nothing counts as produced until a stage of this run completes.
  snap:=o.packet-'draftCheckRequest';
  -- A reviewer choosing a company IS the acceptance this contract describes. Without it these
  -- packets are judged against the unrelated discovery ICP and stop before any research happens.
  -- The band is the selected-company profile, not any particular company, and acceptance never
  -- overrides contradicting data: fact resolution still raises a genuine conflict as a question.
  if not (snap ? 'eligibility') then
   snap:=jsonb_set(snap,'{eligibility}',jsonb_build_object(
    'basis','user_accepted_cohort',
    'cohort','selected run '||r.id::text,
    'acceptedNote','Chosen by a reviewer for this selected-company run. Employee count, revenue and growth remain unknown unless separately evidenced; acceptance does not supply them.',
    'employeeRange',jsonb_build_object('min',200),
    'countries',jsonb_build_array('US')));
  end if;
  snap:=jsonb_set(snap,'{recovery}',jsonb_build_object('version','kvd101','reason','selected_run',
   'stage',entry,'requestedAt',now(),'retryUrls','[]'::jsonb));
  snap:=jsonb_set(snap,'{state}',to_jsonb('research_requested'::text));
  update public.opportunities set packet=snap,state='research_requested',revision=revision+1,updated_at=now() where id=o.id;
  insert into public.workflow_run_members(run_id,organization_id,opportunity_id,entry_revision,entry_state,queued_stage)
  values(r.id,p_organization,o.id,o.revision+1,o.state,entry);
  insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload,run_id)
  values(p_organization,o.campaign_id,o.id,r.id::text||':selected:'||o.id::text,entry,
         md5(snap::text),o.revision+1,'kvd101','kvd101',snap,r.id);
  queued:=queued+1;
 end loop;

 if queued=0 then raise exception 'no_selectable_companies'; end if;
 return to_jsonb(r)||jsonb_build_object('created',true,'queued',queued,'skipped',skipped,'campaigns',to_jsonb(campaigns_seen));
end $$;

create or replace function public.start_selected_workflow(
 p_organization uuid, p_opportunities uuid[], p_request uuid
) returns jsonb language sql security invoker set search_path='' as $$
 select private.start_selected_workflow(p_organization,p_opportunities,p_request);
$$;

-- ---------------------------------------------------------------------------------------------
-- Selection and run-scoped status
-- ---------------------------------------------------------------------------------------------
create or replace function private.selectable_companies(p_organization uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or not exists(select 1 from public.memberships where organization_id=p_organization and user_id=auth.uid())
  then raise exception 'membership_required'; end if;
 select coalesce(jsonb_agg(row order by row.campaign_name,row.name),'[]'::jsonb) into result from (
  select c.id as campaign_id, c.name as campaign_name, o.id as opportunity_id, o.state,
   coalesce(o.packet->'research'->>'company',o.packet->'candidate'->'providerCompany'->>'name','Unnamed company') as name,
   coalesce(o.packet->'research'->>'accountHost',o.packet->'candidate'->'providerCompany'->>'domain') as host,
   (o.state not in ('rejected','disqualified','relationship_handoff','icp_mismatch','service_mismatch')) as selectable
  from public.campaigns c join public.opportunities o on o.campaign_id=c.id
  where c.organization_id=p_organization and not c.paused and o.packet->>'mode'='live'
 ) row;
 return result;
end $$;
create or replace function public.selectable_companies(p_organization uuid) returns jsonb
 language sql security invoker set search_path='' as $$ select private.selectable_companies(p_organization); $$;

-- Reports the revision this run completed, not merely the latest packet, so a later run cannot
-- rewrite an earlier run's reported outcome.
create or replace function private.selected_run_status(p_organization uuid, p_run uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or not exists(select 1 from public.memberships where organization_id=p_organization and user_id=auth.uid())
  then raise exception 'membership_required'; end if;
 select jsonb_build_object(
  'run',to_jsonb(w),
  'members',coalesce((select jsonb_agg(jsonb_build_object(
     'opportunityId',m.opportunity_id,'entryRevision',m.entry_revision,'entryState',m.entry_state,
     'queuedStage',m.queued_stage,'resultRevision',m.result_revision,'completedAt',m.completed_at,
     'lastCompletedStage',m.last_completed_stage,'currentRevision',o.revision,
     'state',coalesce(m.result_state,o.state),'updatedAt',o.updated_at,
     'packet',coalesce(m.result_packet,o.packet)) order by m.created_at)
   from public.workflow_run_members m join public.opportunities o on o.id=m.opportunity_id
   where m.run_id=w.id),'[]'::jsonb),
  'jobs',coalesce((select jsonb_agg(jsonb_build_object('id',j.id,'opportunityId',j.opportunity_id,
     'stage',j.stage,'status',j.status,'attempts',j.attempts,'error',j.error) order by j.created_at)
   from public.jobs j where j.run_id=w.id),'[]'::jsonb)
 ) into result from public.workflow_runs w where w.id=p_run and w.organization_id=p_organization;
 if result is null then raise exception 'run_not_found'; end if;
 return result;
end $$;
create or replace function public.selected_run_status(p_organization uuid,p_run uuid) returns jsonb
 language sql security invoker set search_path='' as $$ select private.selected_run_status(p_organization,p_run); $$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: the established pattern grants EXECUTE on the private implementation AND the public
-- wrapper, because the wrappers are SECURITY INVOKER and run as the calling role.
-- ---------------------------------------------------------------------------------------------
revoke execute on function
 private.start_selected_workflow(uuid,uuid[],uuid),public.start_selected_workflow(uuid,uuid[],uuid),
 private.selectable_companies(uuid),public.selectable_companies(uuid),
 private.selected_run_status(uuid,uuid),public.selected_run_status(uuid,uuid),
 private.selected_entry_stage(jsonb),private.record_run_result() from public,anon;
grant execute on function
 private.start_selected_workflow(uuid,uuid[],uuid),public.start_selected_workflow(uuid,uuid[],uuid),
 private.selectable_companies(uuid),public.selectable_companies(uuid),
 private.selected_run_status(uuid,uuid),public.selected_run_status(uuid,uuid) to authenticated;
grant execute on function private.selected_entry_stage(jsonb) to service_role;
