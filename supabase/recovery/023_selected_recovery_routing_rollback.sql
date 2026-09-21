-- Recovery for supabase/migrations/20260921113615_selected_recovery_routing.sql, which Supabase's
-- native migration tool recorded as version 20260921113615_selected_recovery_routing. The source
-- filename was aligned to that recorded version; the reviewed SQL bytes are unchanged.
--
-- The migration changed only function bodies, so this recovery is proportional: it restores the
-- previous routing behaviour and removes the added action, and touches no row, column or index.
--
--   * private.selected_entry_stage returns to the evidence heuristic, and private.recovery_stage to
--     its kvd101 body. A packet left in the provisional-fit state then resolves through the evidence
--     heuristic instead, which is the pre-migration behaviour for any state it does not name.
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

-- recovery_stage returns to its kvd101 body, without the provisional-fit state.
create or replace function private.recovery_stage(p jsonb) returns text language plpgsql immutable security invoker set search_path='' as $$
begin
 if p->>'state' in ('rejected','reject','disqualified','defer','deferred','watch','relationship_handoff','icp_mismatch','service_mismatch') then return null; end if;
 if p->>'state'='research_requested' and p#>>'{recovery,stage}' in ('S04','S05','S06','S08','S09','S10','S11') then return p#>>'{recovery,stage}'; end if;
 if p->>'state'='review_capacity_deferred' then return 'S09'; end if;
 if p->>'state'='company_assessment_pending' then return 'S05'; end if;
 if p->>'state' in ('company_context_pending','source_pending','identity_conflict','weak_context','procurement_pending') or jsonb_array_length(coalesce(p->'evidence','[]'))=0 then return 'S04'; end if;
 if p->'research' is null then return 'S06'; end if;
 if p->>'state' in ('website_pending','specialist_exception','specialist_repairing') then return 'S08'; end if;
 if p#>>'{packetReview,acceptable}' is distinct from 'true' or p->>'state'='evidence_exception' then return 'S09'; end if;
 if p#>>'{contact,state}' is distinct from 'resolved' and p->>'state'='contact_pending' then return 'S10'; end if;
 if p->'draft' is null or p#>>'{draftReview,acceptable}' is distinct from 'true' or p->>'state' in ('draft_exception','draft_writing_review','review_required') then return 'S11'; end if;
 return null;
end $$;
revoke all on function private.recovery_stage(jsonb) from public,anon,authenticated;

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
