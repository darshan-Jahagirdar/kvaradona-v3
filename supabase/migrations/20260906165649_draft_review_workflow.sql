alter table public.reviews drop constraint reviews_action_check;
alter table public.reviews add constraint reviews_action_check check(action in ('edit','recheck','defer','reject','research','approve'));
-- Save human edits or recheck requests with exactly one A5 job; never rewrite human wording.
create or replace function private.review_opportunity(p_id uuid,p_revision integer,p_request uuid,p_action text,p_note text,p_draft jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare o public.opportunities; r public.reviews; snap jsonb; request_payload jsonb;
begin
 request_payload:=jsonb_build_object('revision',p_revision,'action',p_action,'note',p_note,'draft',p_draft);
 if auth.uid() is null then raise exception 'authentication_required'; end if;
 select * into o from public.opportunities where id=p_id for update;
 if not found or not exists(select 1 from public.memberships where organization_id=o.organization_id and user_id=auth.uid()) then raise exception 'not_found'; end if;
 select * into r from public.reviews where organization_id=o.organization_id and request_key=p_request;
 if found then
  if r.opportunity_id<>p_id or r.reviewer_id<>auth.uid() or r.request_payload is distinct from request_payload then raise exception 'request_key_conflict'; end if;
  return to_jsonb(r);
 end if;
 if o.revision<>p_revision then raise exception 'stale_version'; end if;
 if p_action='approve' then raise exception 'sending_disabled_provider_pending'; end if;
 if p_action is null or p_action not in ('edit','recheck','defer','reject','research') or p_note is null or length(trim(p_note)) not between 1 and 3000 then raise exception 'review_reason_required'; end if;
 snap:=o.packet;
 if p_action='research' then
  snap:=snap-'research'-'packetReview'-'draftReview'-'draft'-'contact'-'draftCheckRequest';
  snap:=jsonb_set(snap,'{researchRequest}',jsonb_build_object('question',p_note,'requestedAt',now(),'reviewerId',auth.uid()));
 end if;
 if p_action in ('edit','recheck') then
  if jsonb_typeof(snap->'draft') is distinct from 'object' or jsonb_typeof(snap->'research') is distinct from 'object' or snap#>>'{packetReview,acceptable}' is distinct from 'true' then raise exception 'checked_packet_and_draft_required'; end if;
  if p_draft is null or jsonb_typeof(p_draft)<>'object' or jsonb_typeof(p_draft->'body') is distinct from 'string' or jsonb_typeof(p_draft->'subject') is distinct from 'string' or length(trim(p_draft->>'body')) not between 1 and 6000 or length(trim(p_draft->>'subject')) not between 1 and 200 then raise exception 'invalid_draft'; end if;
  if (p_draft-'subject'-'body') is distinct from ((snap->'draft')-'subject'-'body') then raise exception 'draft_identity_or_claims_changed'; end if;
  if p_action='recheck' and p_draft is distinct from snap->'draft' then raise exception 'save_edits_before_recheck'; end if;
  snap:=jsonb_set(snap,'{draft}',p_draft)-'draftReview';
  snap:=jsonb_set(snap,'{draftCheckRequest}',jsonb_build_object('requestedAt',now(),'reviewerId',auth.uid()));
 end if;
 snap:=jsonb_set(snap,'{state}',to_jsonb(case p_action when 'edit' then 'review_required' when 'recheck' then 'review_required' when 'research' then 'research_requested' else p_action end));
 insert into public.reviews(organization_id,opportunity_id,revision,request_key,reviewer_id,action,note,snapshot,request_payload)
 values(o.organization_id,o.id,o.revision,p_request,auth.uid(),p_action,p_note,o.packet,request_payload) returning * into r;
 update public.opportunities set packet=snap,revision=revision+1,state=snap->>'state',updated_at=now() where id=o.id;
 -- Obsolete queued or leased jobs cannot keep a reviewed/deferred version active.
 update public.jobs set status='blocked',error='superseded_by_review',lease_until=null
 where opportunity_id=o.id and organization_id=o.organization_id and input_version<=o.revision and status in ('queued','running');
 if p_action in ('edit','recheck') then
  insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
  values(o.organization_id,o.campaign_id,o.id,o.id::text||':draft-check:'||p_request::text,'S11',md5(snap::text),o.revision+1,'1','9',snap);
 end if;
 if p_action='research' then
  insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
  values(o.organization_id,o.campaign_id,o.id,o.id::text||':research-request:'||p_request::text,case when jsonb_array_length(coalesce(snap->'evidence','[]'::jsonb))>0 then 'S06' else 'S04' end,md5(snap::text),o.revision+1,'1','2',snap);
 end if;
 return to_jsonb(r);
end $$;
