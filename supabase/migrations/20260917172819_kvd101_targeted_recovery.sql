-- Additive recovery contracts. No opportunity, grant, allowance, hold or draft is rewritten.
alter table public.reviews drop constraint reviews_action_check;
alter table public.reviews add constraint reviews_action_check check(action in ('edit','recheck','defer','reject','research','resume','refresh_contact_search','approve'));

create function private.recovery_stage(p jsonb) returns text language plpgsql immutable security invoker set search_path='' as $$
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

alter function private.review_opportunity(uuid,integer,uuid,text,text,jsonb) rename to review_opportunity_pre_kvd101;
create function private.review_opportunity(p_id uuid,p_revision integer,p_request uuid,p_action text,p_note text,p_draft jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare o public.opportunities; r public.reviews; snap jsonb; request_payload jsonb; resume_stage text; retry_urls jsonb;
begin
 if p_action not in ('resume','research','refresh_contact_search') then return private.review_opportunity_pre_kvd101(p_id,p_revision,p_request,p_action,p_note,p_draft); end if;
 if auth.uid() is null then raise exception 'authentication_required'; end if;
 select * into o from public.opportunities where id=p_id for update;
 if not found or not exists(select 1 from public.memberships where organization_id=o.organization_id and user_id=auth.uid()) then raise exception 'not_found'; end if;
 request_payload:=jsonb_build_object('revision',p_revision,'action',p_action,'note',p_note,'draft',p_draft);
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
 resume_stage:=private.recovery_stage(o.packet);
 if p_action='refresh_contact_search' then resume_stage:='S10'; end if;
 if p_action='research' then resume_stage:=case when jsonb_array_length(coalesce(o.packet->'evidence','[]'))>0 then 'S06' else 'S04' end; end if;
 if resume_stage is null then raise exception 'recovery_not_available'; end if;
 -- An uncertain paid dispatch is never implicitly replaced, including through a new job ID.
 if exists(select 1 from public.provider_operations x join public.jobs j on j.id=x.job_id where x.opportunity_id=o.id and j.stage=resume_stage and x.state in ('reserved','dispatched','ambiguous')) then raise exception 'ambiguous_operation_hold'; end if;
 snap:=o.packet-'draftCheckRequest';
 if p_action='refresh_contact_search' then snap:=jsonb_set(snap,'{contactSearchRequest}',jsonb_build_object('requestId',p_request,'reason',p_note,'requestedAt',now())); end if;
 select coalesce(jsonb_agg(a->>'url'),'[]'::jsonb) into retry_urls from jsonb_array_elements(coalesce(snap->'contextAttempts','[]')) a
 where a->>'stage'='robots' and a->>'code' in ('robots_disallowed','robots_invalid_format') and snap#>>'{recovery,version}' is distinct from 'kvd101';
 snap:=jsonb_set(snap,'{recovery}',jsonb_build_object('version','kvd101','reason',case p_action when 'research' then 'question' else 'missing_step' end,'stage',resume_stage,'requestedAt',now(),'retryUrls',retry_urls));
 if p_action='research' then snap:=jsonb_set(snap,'{researchRequest}',jsonb_build_object('question',p_note,'requestedAt',now(),'reviewerId',auth.uid())); end if;
 -- Keep prior checks attached until changed material actually invalidates them in the stage.
 snap:=jsonb_set(snap,'{state}',to_jsonb('research_requested'::text));
 insert into public.reviews(organization_id,opportunity_id,revision,request_key,reviewer_id,action,note,snapshot,request_payload)
 values(o.organization_id,o.id,o.revision,p_request,auth.uid(),p_action,p_note,o.packet,request_payload) returning * into r;
 update public.opportunities set packet=snap,state='research_requested',revision=revision+1,updated_at=now() where id=o.id;
 insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
 values(o.organization_id,o.campaign_id,o.id,o.id::text||':kvd101:'||p_request::text,resume_stage,md5(snap::text),o.revision+1,'kvd101','kvd101',snap);
 return to_jsonb(r);
end $$;
revoke all on function private.review_opportunity_pre_kvd101(uuid,integer,uuid,text,text,jsonb),private.review_opportunity(uuid,integer,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function private.review_opportunity(uuid,integer,uuid,text,text,jsonb) to authenticated;
-- Rebind the public invoker wrapper to the current private command after the rename.
create or replace function public.review_opportunity(p_id uuid,p_revision integer,p_request uuid,p_action text,p_note text,p_draft jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.review_opportunity(p_id,p_revision,p_request,p_action,p_note,p_draft); $$;

-- Discovery remains governed by its existing launch/access guards. Review capacity is
-- allocated atomically when a checked S09 packet is promoted, within this campaign only.
alter function public.complete_job(uuid,uuid,jsonb,jsonb) rename to complete_job_pre_kvd101;
create function public.complete_job(p_job uuid,p_token uuid,p_output jsonb,p_next jsonb) returns boolean
 language plpgsql security invoker set search_path='' as $$
declare j public.jobs; profile jsonb; allocation jsonb; policy_share numeric; capacity integer; exploration_limit integer;
 admitted_count integer; exploration_count integer; allocation_decision text; allocation_reason text;
begin
 select * into j from public.jobs where id=p_job for update;
 if not found then return false; end if;
 if j.stage='S09' and j.status='running' and j.attempt_token=p_token and j.lease_until>now() and p_next->>'stage'='S10' then
  select c.profile into profile from public.campaigns c where c.id=j.campaign_id and c.organization_id=j.organization_id for update;
  policy_share:=coalesce((profile->>'explorationShare')::numeric,0.2);
  capacity:=coalesce((profile->>'reviewCapacity')::integer,nullif((profile->>'maxResearch')::integer,0),4);
  if policy_share<0 or policy_share>1 or capacity<1 or capacity>100 then raise exception 'invalid_review_capacity_policy'; end if;
  -- Round the exploration reservation upward for a small cohort (20% of 4 permits 1).
  exploration_limit:=ceil(capacity*policy_share);
  select count(*),count(*) filter(where packet#>>'{research,decision}'='exploration') into admitted_count,exploration_count
   from public.opportunities where organization_id=j.organization_id and campaign_id=j.campaign_id and id<>j.opportunity_id
    and packet#>>'{reviewAllocation,decision}'='admitted';
  if p_output?'recovery' or p_output?'draft' then
   allocation_decision:='diagnostic';allocation_reason:='Explicit saved-company recovery or preserved draft; separate from discovery review allocation.';
  elsif admitted_count>=capacity then
   allocation_decision:='deferred';allocation_reason:='Campaign review capacity is filled; candidate remains visible for later review.';
  elsif p_output#>>'{research,decision}'='exploration' and exploration_count>=exploration_limit then
   allocation_decision:='deferred';allocation_reason:='Campaign exploration slots are filled; priority shortfall is not backfilled with exploration.';
  else allocation_decision:='admitted';allocation_reason:='Within this campaign review capacity and exploration allocation.';
  end if;
  allocation:=jsonb_build_object('cohortId',j.campaign_id,'policyShare',policy_share,'capacity',capacity,'explorationLimit',exploration_limit,'decision',allocation_decision,'reason',allocation_reason);
  p_output:=jsonb_set(p_output,'{reviewAllocation}',allocation);
  if allocation_decision='deferred' then p_output:=jsonb_set(p_output,'{state}','"review_capacity_deferred"'::jsonb);p_next:=null;
  else p_next:=jsonb_set(p_next,'{input_hash}',to_jsonb(md5(p_output::text)));end if;
 end if;
 return public.complete_job_pre_kvd101(p_job,p_token,p_output,p_next);
end $$;
revoke all on function public.complete_job(uuid,uuid,jsonb,jsonb),public.complete_job_pre_kvd101(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.complete_job(uuid,uuid,jsonb,jsonb),public.complete_job_pre_kvd101(uuid,uuid,jsonb,jsonb) to service_role;
