-- Restore previous command implementations without deleting new reviews, jobs or packets.
-- Stop the worker and restore the previous application first. Do not run while jobs are active.
begin;
do $$ begin if exists(select 1 from public.jobs where status in ('queued','running') and schema_version='kvd101') then raise exception 'kvd101_jobs_must_be_drained_or_explicitly_parked'; end if; end $$;
drop function public.review_opportunity(uuid,integer,uuid,text,text,jsonb);
drop function private.review_opportunity(uuid,integer,uuid,text,text,jsonb);
alter function private.review_opportunity_pre_kvd101(uuid,integer,uuid,text,text,jsonb) rename to review_opportunity;
grant execute on function private.review_opportunity(uuid,integer,uuid,text,text,jsonb) to authenticated;
create function public.review_opportunity(p_id uuid,p_revision integer,p_request uuid,p_action text,p_note text,p_draft jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.review_opportunity(p_id,p_revision,p_request,p_action,p_note,p_draft); $$;
revoke all on function public.review_opportunity(uuid,integer,uuid,text,text,jsonb) from public,anon;
grant execute on function public.review_opportunity(uuid,integer,uuid,text,text,jsonb) to authenticated;
drop function public.complete_job(uuid,uuid,jsonb,jsonb);
alter function public.complete_job_pre_kvd101(uuid,uuid,jsonb,jsonb) rename to complete_job;
drop function private.recovery_stage(jsonb);
-- Retain the additive action constraint because historical resume reviews must stay readable.
commit;
