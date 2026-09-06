-- Recovery to the verified empty baseline ONLY before application records/users exist.
-- Later recovery needs a fresh data backup; this script refuses to delete populated data.
do $$ begin
 if exists(select 1 from public.campaigns) or exists(select 1 from auth.users) or exists(select 1 from public.provider_operations) then
 raise exception 'nonempty_database_requires_backup_restore'; end if;
end $$;
drop function public.operational_status();
drop function public.review_opportunity(uuid,integer,uuid,text,text,jsonb);
drop function private.operational_status();
drop function private.review_opportunity(uuid,integer,uuid,text,text,jsonb);
drop function public.ingest_discovery(uuid,uuid,jsonb,jsonb);
drop function public.tick_schedules();
drop function public.complete_job(uuid,uuid,jsonb,jsonb);
drop function public.record_operation(uuid,text,jsonb,jsonb,numeric);
drop function public.dispatch_operation(uuid,uuid,uuid);
drop function public.reserve_operation(uuid,uuid,text,text,text,numeric,integer);
drop function public.fail_job(uuid,uuid,text,boolean);
drop function public.renew_job(uuid,uuid);
drop function public.claim_job(text);
drop table public.reviews,public.relationships,public.worker_heartbeats,public.schedules,public.provider_operations,public.provider_limits,public.budget,public.stage_runs,public.jobs,public.evidence,public.opportunities,public.campaigns,public.memberships,public.organizations;
drop schema private;
