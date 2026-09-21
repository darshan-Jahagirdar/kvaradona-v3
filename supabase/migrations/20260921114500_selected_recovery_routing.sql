-- Selected-run recovery routing.
--
-- Two corrections, both about where authorized work RESUMES and under whose authority:
--
--  1. private.selected_entry_stage returned S06 for any packet holding evidence and S04 otherwise,
--     so a selected recovery of a company that already has checked research and a preserved draft
--     re-ran A2 instead of resuming at the contact step. It now asks private.recovery_stage, the
--     function the ordinary reviewer path already uses, and keeps the old evidence heuristic only
--     as the fallback for packets that function cannot place.
--
--  2. An ordinary reviewer action queued its recovery job with no run_id, so a company inside an
--     active selected run silently fell back to campaign authority and lost that run's membership,
--     persona policy and finite contact window. The recovery job now carries the run it belongs to
--     whenever the opportunity is a member of an active, unexpired selected run.
--
-- It also adds one reviewer action, identify_company, for the single question the pipeline cannot
-- answer by itself: which company a selected careers or index record belongs to. The answer is
-- stored as a HINT with structured name/domain fields and status 'unverified'. The stage verifies
-- it against that company's own published identity before attributing anything to it; typing a
-- domain never certifies it. Answering supersedes the open question rather than leaving it posted.
--
-- It also re-declares private.recovery_stage so a packet whose classification fit is provisional
-- resumes at company context rather than at the assessment it already completed.
--
-- The only schema change is widening the reviews.action check constraint to admit the new action;
-- no table, column or index is added. Exclusions, holds, accounting and sending are untouched.

begin;

-- A reviewer's identity answer is an ordinary recorded review, so the action must be admitted by the
-- same constraint every other review action passes.
alter table public.reviews drop constraint reviews_action_check;
alter table public.reviews add constraint reviews_action_check
 check(action in ('edit','recheck','defer','reject','research','resume','refresh_contact_search','identify_company','approve'));

-- A company whose classification fit is provisional has already passed S05; the affected step is
-- company context, not the assessment it just completed. Without this, a recovery of that packet
-- would fall through to the evidence heuristic and re-enter the wrong stage.
create or replace function private.recovery_stage(p jsonb) returns text language plpgsql immutable security invoker set search_path='' as $$
begin
 if p->>'state' in ('rejected','reject','disqualified','defer','deferred','watch','relationship_handoff','icp_mismatch','service_mismatch') then return null; end if;
 if p->>'state'='research_requested' and p#>>'{recovery,stage}' in ('S04','S05','S06','S08','S09','S10','S11') then return p#>>'{recovery,stage}'; end if;
 if p->>'state'='review_capacity_deferred' then return 'S09'; end if;
 if p->>'state'='company_assessment_pending' then return 'S05'; end if;
 if p->>'state' in ('company_context_pending','facts_provisional','source_pending','identity_conflict','weak_context','procurement_pending') or jsonb_array_length(coalesce(p->'evidence','[]'))=0 then return 'S04'; end if;
 if p->'research' is null then return 'S06'; end if;
 if p->>'state' in ('website_pending','specialist_exception','specialist_repairing') then return 'S08'; end if;
 if p#>>'{packetReview,acceptable}' is distinct from 'true' or p->>'state'='evidence_exception' then return 'S09'; end if;
 if p#>>'{contact,state}' is distinct from 'resolved' and p->>'state'='contact_pending' then return 'S10'; end if;
 if p->'draft' is null or p#>>'{draftReview,acceptable}' is distinct from 'true' or p->>'state' in ('draft_exception','draft_writing_review','review_required') then return 'S11'; end if;
 return null;
end $$;
revoke all on function private.recovery_stage(jsonb) from public,anon,authenticated;

create or replace function private.selected_entry_stage(p jsonb) returns text
 language sql immutable security invoker set search_path='' as $$
 select coalesce(
  private.recovery_stage(p),
  case when jsonb_array_length(coalesce(p->'evidence','[]'::jsonb))>0 then 'S06' else 'S04' end);
$$;

alter function private.review_opportunity(uuid,integer,uuid,text,text,jsonb) rename to review_opportunity_kvd101;

create function private.review_opportunity(
 p_id uuid,p_revision integer,p_request uuid,p_action text,p_note text,p_draft jsonb,p_input jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.opportunities; r public.reviews; snap jsonb; request_payload jsonb; resume_stage text;
 retry_urls jsonb; run_owner uuid; hint_name text; hint_domain text;
begin
 if p_action not in ('resume','research','refresh_contact_search','identify_company')
  then return private.review_opportunity_pre_kvd101(p_id,p_revision,p_request,p_action,p_note,p_draft); end if;
 if auth.uid() is null then raise exception 'authentication_required'; end if;
 select * into o from public.opportunities where id=p_id for update;
 if not found or not exists(select 1 from public.memberships where organization_id=o.organization_id and user_id=auth.uid()) then raise exception 'not_found'; end if;
 request_payload:=jsonb_build_object('revision',p_revision,'action',p_action,'note',p_note,'draft',p_draft,'input',p_input);
 select * into r from public.reviews where organization_id=o.organization_id and request_key=p_request;
 if found then
  if r.opportunity_id<>p_id or r.reviewer_id<>auth.uid() or r.request_payload is distinct from request_payload then raise exception 'request_key_conflict'; end if;
  return to_jsonb(r);
 end if;
 if o.revision<>p_revision then raise exception 'stale_version'; end if;
 if p_request is null or p_note is null or length(trim(p_note)) not between 1 and 3000 then raise exception 'review_reason_required'; end if;
 if p_draft is distinct from o.packet->'draft' and not (p_draft='null'::jsonb and o.packet->'draft' is null) then raise exception 'save_edits_before_recovery'; end if;
 if exists(select 1 from public.jobs where opportunity_id=o.id and status in ('queued','running')) then raise exception 'recovery_in_progress'; end if;
 if p_action='refresh_contact_search' and (length(trim(p_note))<20 or o.packet->'research' is null or o.packet#>>'{packetReview,acceptable}' is distinct from 'true' or o.packet#>>'{contact,state}'='resolved') then raise exception 'contact_refresh_reason_and_checked_packet_required'; end if;

 -- An identity answer is accepted only where the pipeline actually asked for one, and only as
 -- structured minimal input. It is never a licence to set a company on any packet.
 if p_action='identify_company' then
  if o.packet#>>'{pendingResolution,nextAction}' is distinct from 'ask_reviewer'
   or o.packet#>>'{pendingResolution,reason}' is distinct from 'identity_unresolved'
   then raise exception 'no_open_identity_question'; end if;
  hint_name:=trim(coalesce(p_input->>'name',''));
  hint_domain:=lower(nullif(trim(coalesce(p_input->>'domain','')),''));
  if hint_name='' or length(hint_name)>200 then raise exception 'identity_answer_required'; end if;
  if hint_domain is null or length(hint_domain)>253
   or hint_domain !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
   then raise exception 'identity_domain_invalid'; end if;
 end if;

 resume_stage:=private.recovery_stage(o.packet);
 if p_action='refresh_contact_search' then resume_stage:='S10'; end if;
 if p_action='research' then resume_stage:=case when jsonb_array_length(coalesce(o.packet->'evidence','[]'))>0 then 'S06' else 'S04' end; end if;
 if p_action='identify_company' then resume_stage:=coalesce(resume_stage,'S04'); end if;
 if resume_stage is null then raise exception 'recovery_not_available'; end if;
 -- An uncertain paid dispatch is never implicitly replaced, including through a new job ID.
 if exists(select 1 from public.provider_operations x join public.jobs j on j.id=x.job_id where x.opportunity_id=o.id and j.stage=resume_stage and x.state in ('reserved','dispatched','ambiguous')) then raise exception 'ambiguous_operation_hold'; end if;

 -- The selected run this company belongs to, if any. Its membership, persona policy and finite
 -- contact window travel with the recovery job instead of being replaced by campaign defaults.
 select w.id into run_owner from public.workflow_runs w
  join public.workflow_run_members m on m.run_id=w.id and m.opportunity_id=o.id
  where w.organization_id=o.organization_id and w.mode='selected' and w.status='active'
   and (w.expires_at is null or w.expires_at>now())
  order by w.created_at desc limit 1;

 snap:=o.packet-'draftCheckRequest';
 if p_action='refresh_contact_search' then snap:=jsonb_set(snap,'{contactSearchRequest}',jsonb_build_object('requestId',p_request,'reason',p_note,'requestedAt',now())); end if;
 select coalesce(jsonb_agg(a->>'url'),'[]'::jsonb) into retry_urls from jsonb_array_elements(coalesce(snap->'contextAttempts','[]')) a
 where a->>'stage'='robots' and a->>'code' in ('robots_disallowed','robots_invalid_format') and snap#>>'{recovery,version}' is distinct from 'kvd101';
 snap:=jsonb_set(snap,'{recovery}',jsonb_build_object(
  'version','kvd101',
  -- A company inside a selected run keeps that run's reason, so the stage applies selected-run
  -- policy. The action that asked for the recovery is preserved separately as its origin.
  'reason',case when run_owner is not null then 'selected_run'
                else case p_action when 'research' then 'question' when 'identify_company' then 'question' else 'missing_step' end end,
  'origin',case p_action when 'research' then 'question' when 'identify_company' then 'identity_answer' else 'missing_step' end,
  'selectedRun',run_owner,
  'stage',resume_stage,'requestedAt',now(),'retryUrls',retry_urls));
 if p_action='research' then snap:=jsonb_set(snap,'{researchRequest}',jsonb_build_object('question',p_note,'requestedAt',now(),'reviewerId',auth.uid())); end if;
 if p_action='identify_company' then
  snap:=jsonb_set(snap,'{identityHint}',jsonb_build_object(
   'name',hint_name,'domain',hint_domain,'note',p_note,'reviewerId',auth.uid(),'at',now(),'status','unverified'));
  -- The posted question is superseded the moment it is answered. The attempt budget restarts
  -- because new information arrived; the stage still bounds how far it can go on it.
  snap:=jsonb_set(snap,'{pendingResolution}',(coalesce(snap->'pendingResolution','{}'::jsonb) - 'question')||jsonb_build_object(
   'nextAction','retry_resolution','attempts',0,'at',now(),
   'detail','A reviewer answered the identity question. The answer is checked against that company''s own published identity before anything is attributed to it.'));
 end if;
 -- Keep prior checks attached until changed material actually invalidates them in the stage.
 snap:=jsonb_set(snap,'{state}',to_jsonb('research_requested'::text));
 insert into public.reviews(organization_id,opportunity_id,revision,request_key,reviewer_id,action,note,snapshot,request_payload)
 values(o.organization_id,o.id,o.revision,p_request,auth.uid(),p_action,p_note,o.packet,request_payload) returning * into r;
 update public.opportunities set packet=snap,state='research_requested',revision=revision+1,updated_at=now() where id=o.id;
 insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload,run_id)
 values(o.organization_id,o.campaign_id,o.id,o.id::text||':kvd101:'||p_request::text,resume_stage,md5(snap::text),o.revision+1,'kvd101','kvd101',snap,run_owner);
 return to_jsonb(r);
end $$;

create or replace function private.review_opportunity(p_id uuid,p_revision integer,p_request uuid,p_action text,p_note text,p_draft jsonb)
 returns jsonb language sql security invoker set search_path='' as $$
 select private.review_opportunity(p_id,p_revision,p_request,p_action,p_note,p_draft,null::jsonb);
$$;
create or replace function public.review_opportunity(p_id uuid,p_revision integer,p_request uuid,p_action text,p_note text,p_draft jsonb)
 returns jsonb language sql security invoker set search_path='' as $$ select private.review_opportunity(p_id,p_revision,p_request,p_action,p_note,p_draft,null::jsonb); $$;
create or replace function public.review_opportunity(p_id uuid,p_revision integer,p_request uuid,p_action text,p_note text,p_draft jsonb,p_input jsonb)
 returns jsonb language sql security invoker set search_path='' as $$ select private.review_opportunity(p_id,p_revision,p_request,p_action,p_note,p_draft,p_input); $$;

revoke all on function
 private.review_opportunity_kvd101(uuid,integer,uuid,text,text,jsonb),
 private.review_opportunity(uuid,integer,uuid,text,text,jsonb),
 private.review_opportunity(uuid,integer,uuid,text,text,jsonb,jsonb)
 from public,anon,authenticated;
grant execute on function
 private.review_opportunity(uuid,integer,uuid,text,text,jsonb),
 private.review_opportunity(uuid,integer,uuid,text,text,jsonb,jsonb) to authenticated;

commit;
