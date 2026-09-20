-- Recovery for supabase/migrations/20260920115456_selected_company_runs.sql
-- (recorded by Supabase as version 20260920115456).
--
-- Runs as one transaction: either the whole recovery applies or nothing does.
--
-- It has two outcomes, decided BEFORE anything is dropped:
--
--   FULL     - NOTHING depends on the objects it drops: no selected run has ever been launched, no
--              membership row exists, no job carries a run_id, and no campaign holds several runs.
--              Behaviour and schema both return to the pre-migration shape, including the original
--              workflow_runs.campaign_id UNIQUE constraint.
--
--   BEHAVIOUR - any selected-run history exists, even a single completed run. Its membership row,
--              result snapshot and jobs.run_id are the only record that it ran, so they are KEPT
--              along with workflow_runs.mode/status/expires_at. Functions, trigger and
--              authorization guards are still reverted. The notice says which outcome ran.
--
-- Launched opportunity revisions, packets and campaign profile changes are ordinary pipeline
-- history and are never reverted by this script.

begin;

do $recover$
declare pending integer; history integer; duplicated integer; full_rollback boolean; definition text; before text; after text;
begin
 -- 1. Decide everything first, while all the evidence is still present.
 select count(*) into pending from public.jobs j join public.workflow_runs w on w.id=j.run_id
  where j.status in ('queued','running');
 if pending>0 then raise exception 'selected_run_still_active: % job(s) queued or running; stop the run first',pending; end if;

 -- FULL is chosen only when NOTHING depends on the objects it drops. One completed selected run is
 -- already history: its membership row, result snapshot and jobs.run_id are the only record that it
 -- ran, so dropping them would destroy evidence even though no campaign holds two runs.
 select count(*) into history from public.workflow_runs w where w.mode='selected';
 select count(*) into duplicated from (
  select campaign_id from public.workflow_runs group by campaign_id having count(*)>1) d;
 full_rollback := history=0 and duplicated=0
  and not exists(select 1 from public.workflow_run_members)
  and not exists(select 1 from public.jobs where run_id is not null);

 -- 2. Authorization guards back to the campaign-wide contact window.
 definition:=pg_get_functiondef('public.reserve_operation(uuid,uuid,text,text,text,numeric,integer)'::regprocedure);
 before:='
 if j.run_id is not null and not exists(select 1 from public.workflow_runs w where w.id=j.run_id and w.organization_id=j.organization_id and w.status=''active'' and (w.expires_at is null or w.expires_at>now()) and (w.mode<>''selected'' or exists(select 1 from public.workflow_run_members m where m.run_id=w.id and m.opportunity_id=j.opportunity_id))) then raise exception ''run_expired_or_stopped''; end if;';
 if position(before in definition)=0 then raise exception 'reserve_run_guard_not_found'; end if;
 definition:=replace(definition,before,'');
 before:='or exists(select 1 from public.workflow_runs w join public.workflow_run_members m on m.run_id=w.id where w.id=j.run_id and w.organization_id=j.organization_id and w.mode=''selected'' and w.status=''active'' and w.expires_at>now() and m.opportunity_id=j.opportunity_id) or (j.run_id is null and exists(select 1 from public.campaigns c join public.workflow_runs w on w.campaign_id=c.id where c.id=j.campaign_id and c.organization_id=j.organization_id and w.mode=''discovery'' and (c.profile->>''contactExecutionExpiresAt'')::timestamptz>now()))';
 after:='or exists(select 1 from public.campaigns c join public.workflow_runs w on w.campaign_id=c.id where c.id=j.campaign_id and c.organization_id=j.organization_id and (c.profile->>''contactExecutionExpiresAt'')::timestamptz>now())';
 if position(before in definition)=0 then raise exception 'reserve_contact_window_not_found'; end if;
 definition:=replace(definition,before,after);
 execute definition;

 definition:=pg_get_functiondef('public.dispatch_operation(uuid,uuid,uuid)'::regprocedure);
 before:='
 if exists(select 1 from public.jobs j where j.id=p_job and j.run_id is not null and not exists(
   select 1 from public.workflow_runs w where w.id=j.run_id and w.organization_id=j.organization_id
   and w.status=''active'' and (w.expires_at is null or w.expires_at>now()))) then raise exception ''run_expired_or_stopped''; end if;';
 if position(before in definition)=0 then raise exception 'dispatch_run_guard_not_found'; end if;
 execute replace(definition,before,'');

 -- 3. Child-job insertion back to its original column list.
 definition:=pg_get_functiondef('public.complete_job_pre_kvd101(uuid,uuid,jsonb,jsonb)'::regprocedure);
 before:='insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload,run_id)';
 if position(before in definition)=0 then raise exception 'complete_job_run_columns_not_found'; end if;
 definition:=replace(definition,before,
  'insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)');
 before:='values(j.organization_id,j.campaign_id,j.opportunity_id,p_next->>''business_key'',p_next->>''stage'',p_next->>''input_hash'',j.input_version,j.schema_version,j.prompt_version,p_output,j.run_id)';
 if position(before in definition)=0 then raise exception 'complete_job_run_values_not_found'; end if;
 definition:=replace(definition,before,
  'values(j.organization_id,j.campaign_id,j.opportunity_id,p_next->>''business_key'',p_next->>''stage'',p_next->>''input_hash'',j.input_version,j.schema_version,j.prompt_version,p_output)');
 execute definition;

 -- 4. The selected-run surface.
 drop trigger if exists jobs_record_run_result on public.jobs;
 drop function if exists private.record_run_result();
 drop function if exists public.selected_run_status(uuid,uuid);
 drop function if exists private.selected_run_status(uuid,uuid);
 drop function if exists public.selectable_companies(uuid);
 drop function if exists private.selectable_companies(uuid);
 drop function if exists public.start_selected_workflow(uuid,uuid[],uuid);
 drop function if exists private.start_selected_workflow(uuid,uuid[],uuid);
 drop function if exists private.selected_entry_stage(jsonb);

 if full_rollback then
  -- 5a. No history depends on the relaxed uniqueness, so the schema returns completely.
  drop index if exists public.jobs_run;
  alter table public.jobs drop column if exists run_id;
  drop table if exists public.workflow_run_members;
  drop index if exists public.workflow_runs_campaign_created;
  drop index if exists public.workflow_runs_one_discovery_per_campaign;
  alter table public.workflow_runs drop constraint if exists workflow_runs_status_check;
  alter table public.workflow_runs drop constraint if exists workflow_runs_mode_check;
  alter table public.workflow_runs drop column if exists expires_at;
  alter table public.workflow_runs drop column if exists status;
  alter table public.workflow_runs drop column if exists mode;
  alter table public.workflow_runs add constraint workflow_runs_campaign_id_key unique(campaign_id);
  raise notice 'FULL recovery: behaviour and schema restored, including the original uniqueness constraint.';
 else
  -- 5b. Behaviour is reverted; the columns and membership rows that hold run history are kept,
  --     because the only way to restore the old constraint is to destroy that history.
  raise notice 'BEHAVIOUR recovery: % selected run(s) and % campaign(s) with multiple runs depend on these objects, so workflow_runs.mode/status/expires_at, jobs.run_id and workflow_run_members were preserved with their records. No history was deleted.',history,duplicated;
 end if;
end $recover$;

commit;
