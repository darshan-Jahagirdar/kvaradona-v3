-- Recovery for supabase/migrations/20260921114500_selected_recovery_routing.sql.
--
-- The migration changed only function bodies, so this recovery is proportional: it restores the
-- previous routing behaviour and removes the added action, and touches no row, column or index.
--
--   * private.selected_entry_stage returns to the evidence heuristic.
--   * private.review_opportunity returns to the kvd101 six-argument command, which queues recovery
--     jobs without a run_id. The seven-argument overload and its public wrapper are dropped, so
--     identify_company is no longer accepted.
--
-- Packets already carrying identityHint, recovery.selectedRun or recovery.origin keep them: they
-- are recorded history of what a reviewer answered and which run a recovery belonged to. The
-- product treats all three as optional, and jobs already queued keep the run they were given.
-- Nothing here deletes a review, a job, a hint or an accounting row.

begin;

do $recover$
begin
 if exists(select 1 from public.jobs where status in ('queued','running') and run_id is not null) then
  raise exception 'selected_run_still_active: stop the run before reverting recovery routing'; end if;
 if to_regprocedure('private.review_opportunity_kvd101(uuid,integer,uuid,text,text,jsonb)') is null then
  raise exception 'routing_migration_not_applied'; end if;
end $recover$;

create or replace function private.selected_entry_stage(p jsonb) returns text
 language sql immutable security invoker set search_path='' as $$
 select case when jsonb_array_length(coalesce(p->'evidence','[]'::jsonb))>0 then 'S06' else 'S04' end;
$$;

drop function if exists public.review_opportunity(uuid,integer,uuid,text,text,jsonb,jsonb);
drop function if exists private.review_opportunity(uuid,integer,uuid,text,text,jsonb);
drop function if exists private.review_opportunity(uuid,integer,uuid,text,text,jsonb,jsonb);
alter function private.review_opportunity_kvd101(uuid,integer,uuid,text,text,jsonb) rename to review_opportunity;
revoke all on function private.review_opportunity(uuid,integer,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function private.review_opportunity(uuid,integer,uuid,text,text,jsonb) to authenticated;
create or replace function public.review_opportunity(p_id uuid,p_revision integer,p_request uuid,p_action text,p_note text,p_draft jsonb)
 returns jsonb language sql security invoker set search_path='' as $$ select private.review_opportunity(p_id,p_revision,p_request,p_action,p_note,p_draft); $$;

-- The constraint narrows again only when no reviewer has actually used the action. A recorded answer
-- is history: it is never deleted to make a constraint fit, so the wider constraint is kept and the
-- notice says which outcome ran.
do $constraint$
begin
 if exists(select 1 from public.reviews where action='identify_company') then
  raise notice 'reviews.action constraint kept wide: % recorded identity answer(s) would otherwise be deleted.',
   (select count(*) from public.reviews where action='identify_company');
 else
  alter table public.reviews drop constraint reviews_action_check;
  alter table public.reviews add constraint reviews_action_check
   check(action in ('edit','recheck','defer','reject','research','resume','refresh_contact_search','approve'));
 end if;
end $constraint$;

commit;
