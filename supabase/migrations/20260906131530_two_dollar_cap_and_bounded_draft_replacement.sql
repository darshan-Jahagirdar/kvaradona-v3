-- User-authorized cumulative cap increase; existing usage and unknown charges stay intact.
begin;
alter table public.budget drop constraint budget_limit_usd_check;
alter table public.budget add constraint budget_limit_usd_check check(limit_usd between 0 and 2);
update public.budget set limit_usd=2,verification=verification || '{"authorizedCapUsd":2,"authorization":"User requested $2 combined OpenAI/Brave cap on 2026-09-06; cumulative, no reset"}'::jsonb where id=1;
update public.provider_limits set limit_usd=case provider when 'openai' then 1.80 else 0.20 end where provider in ('openai','brave');

-- Operator-only, one explicit replacement generation. This never settles or retries the old operation.
create function public.replace_ambiguous_draft(p_operation uuid,p_reason text) returns uuid
language plpgsql security invoker set search_path='' as $$
declare op public.provider_operations; j public.jobs; o public.opportunities; replacement public.jobs; body jsonb; key text;
begin
 if p_reason is null or length(trim(p_reason)) not between 20 and 1000 then raise exception 'replacement_reason_required'; end if;
 select * into op from public.provider_operations where id=p_operation for update;
 if not found then raise exception 'operation_missing'; end if;
 select * into j from public.jobs where id=op.job_id for update;
 key:=j.business_key||':bounded-replacement';
 select * into replacement from public.jobs where organization_id=j.organization_id and business_key=key;
 if found then
  if replacement.payload->'draftReplacement'->>'reason'<>p_reason then raise exception 'replacement_request_conflict'; end if;
  return replacement.id;
 end if;
 if j.stage<>'S11' or j.status not in ('blocked','failed') or j.payload ? 'draftReplacement'
  or op.provider<>'openai' or op.operation_key<>j.business_key||':draft'
  or op.state not in ('dispatched','ambiguous') or op.actual_usd is not null or op.response is not null
 then raise exception 'draft_replacement_not_eligible'; end if;
 select * into o from public.opportunities where id=j.opportunity_id and organization_id=j.organization_id for update;
 if not found or o.revision<>j.input_version or o.packet ? 'draft'
  or not coalesce((o.packet->'packetReview'->>'acceptable')::boolean,false)
  or o.state in ('rejected','deferred','relationship_handoff') then raise exception 'draft_replacement_stale'; end if;
 body:=o.packet||jsonb_build_object('draftReplacement',jsonb_build_object('operationId',op.id,'model','gpt-5.6-terra','reason',p_reason,'requestedAt',now()));
 insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
 values(j.organization_id,j.campaign_id,j.opportunity_id,key,'S11',encode(sha256(convert_to(body::text,'UTF8')),'hex'),o.revision,j.schema_version,'3',body)
 returning * into replacement;
 return replacement.id;
end $$;
revoke all on function public.replace_ambiguous_draft(uuid,text) from public,anon,authenticated;
grant execute on function public.replace_ambiguous_draft(uuid,text) to service_role;
commit;
