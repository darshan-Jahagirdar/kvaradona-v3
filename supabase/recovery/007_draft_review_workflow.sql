-- Restore the previous review function; all records and queued jobs are preserved.
-- Commit review feedback and its next-version research job in the same transaction.
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
 if p_action is null or p_action not in ('edit','defer','reject','research') or p_note is null or length(trim(p_note))=0 then raise exception 'review_reason_required'; end if;
 snap:=o.packet;
 if p_action='research' then
  snap:=snap-'research'-'packetReview'-'draftReview'-'draft'-'contact';
  snap:=jsonb_set(snap,'{researchRequest}',jsonb_build_object('question',p_note,'requestedAt',now(),'reviewerId',auth.uid()));
 end if;
 if p_action='edit' then
  if p_draft is null or jsonb_typeof(p_draft)<>'object' or p_draft->>'body' is null or p_draft->>'subject' is null or length(p_draft->>'body') not between 1 and 6000 or length(p_draft->>'subject') not between 1 and 200 then raise exception 'invalid_draft'; end if;
  snap:=jsonb_set(snap,'{draft}',p_draft)-'draftReview';
 end if;
 snap:=jsonb_set(snap,'{state}',to_jsonb(case p_action when 'edit' then 'review_required' when 'research' then 'research_requested' else p_action end));
 insert into public.reviews(organization_id,opportunity_id,revision,request_key,reviewer_id,action,note,snapshot,request_payload)
 values(o.organization_id,o.id,o.revision,p_request,auth.uid(),p_action,p_note,o.packet,request_payload) returning * into r;
 update public.opportunities set packet=snap,revision=revision+1,state=snap->>'state',updated_at=now() where id=o.id;
 if p_action='research' then
  insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
  values(o.organization_id,o.campaign_id,o.id,o.id::text||':research-request:'||p_request::text,case when jsonb_array_length(coalesce(snap->'evidence','[]'::jsonb))>0 then 'S06' else 'S04' end,md5(snap::text),o.revision+1,'1','2',snap);
 end if;
 return to_jsonb(r);
end $$;
