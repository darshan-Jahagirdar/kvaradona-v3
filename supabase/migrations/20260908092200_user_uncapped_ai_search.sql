-- User explicitly removed OpenAI/Brave dollar guards after active work finished.
-- Preserve all usage, reservations, credit accounting, provider identity checks and sending restrictions.
begin;
do $$ begin if exists(select 1 from public.jobs where status in('queued','running')) then raise exception 'active_work'; end if;end $$;
alter table public.budget add column dollar_limits_enabled boolean not null default true;
update public.budget set dollar_limits_enabled=false, verification=verification || '{"dollarLimitsAuthorization":"User explicitly requested no OpenAI or Brave cost safeguards on 2026-09-08, after current work finished. Usage and unresolved reservations stay recorded."}'::jsonb where id=1;
create or replace function public.reserve_operation(p_job uuid,p_token uuid,p_key text,p_provider text,p_hash text,p_max numeric,p_units integer) returns jsonb
 language plpgsql security invoker set search_path='' as $$
declare j public.jobs; o public.provider_operations; b public.budget; l public.provider_limits; total numeric; provider_total numeric; campaign_total numeric; opportunity_total numeric; consumed integer;
begin
 select * into b from public.budget where id=1 for update;
 select * into j from public.jobs where id=p_job and attempt_token=p_token and status='running' and lease_until>now();
 if not found then raise exception 'ownership_lost'; end if;
 if j.opportunity_id is not null and not exists(select 1 from public.opportunities where id=j.opportunity_id and revision=j.input_version) then raise exception 'stale_version'; end if;
 if exists(select 1 from public.campaigns where id=j.campaign_id and paused) then raise exception 'campaign_paused'; end if;
 select * into o from public.provider_operations where organization_id=j.organization_id and operation_key=p_key;
 if found then
  if o.request_hash<>p_hash or o.provider<>p_provider or o.job_id<>p_job then raise exception 'operation_key_conflict'; end if;
  return to_jsonb(o);
 end if;
 if p_max is null or p_units is null or p_max<0 or p_units<0 or (b.dollar_limits_enabled and p_max>0.25) then raise exception 'invalid_reservation'; end if;
 if not b.live_enabled then raise exception 'live_disabled'; end if;
 select * into l from public.provider_limits where provider=p_provider;
 if not found or not (l.probe_enabled or (l.authenticated and l.usable)) or l.verified_at is null or ((b.dollar_limits_enabled or p_provider not in ('openai','brave')) and (l.expires_at<=now() or l.expires_at is null)) then raise exception 'provider_unverified'; end if;
 if p_provider='explorium' and exists(select 1 from public.provider_operations held_op where held_op.provider='explorium' and (held_op.state in('dispatched','ambiguous') or (held_op.state='succeeded' and private.verified_explorium_units(held_op) is null))) then raise exception 'explorium_credit_accounting_hold';end if;
 select coalesce(sum(coalesce(actual_usd,reserved_usd)),0),
 coalesce(sum(coalesce(actual_usd,reserved_usd)) filter(where provider=p_provider),0),
 coalesce(sum(coalesce(actual_usd,reserved_usd)) filter(where campaign_id=j.campaign_id),0),
 coalesce(sum(coalesce(actual_usd,reserved_usd)) filter(where opportunity_id=j.opportunity_id),0),
 coalesce(sum(case when provider='explorium' then coalesce(private.verified_explorium_units(provider_operations),units) else units end) filter(where provider=p_provider),0)
 into total,provider_total,campaign_total,opportunity_total,consumed from public.provider_operations;
 if b.dollar_limits_enabled and (total+p_max>b.limit_usd or provider_total+p_max>l.limit_usd or campaign_total+p_max>0.90 or (j.opportunity_id is not null and opportunity_total+p_max>0.25)) then raise exception 'budget_paused'; end if;
 if p_provider not in ('openai','brave') and (p_max<>0 or consumed+p_units>l.free_units) then raise exception 'free_quota_unverified_or_exhausted'; end if;
 insert into public.provider_operations(organization_id,job_id,campaign_id,opportunity_id,operation_key,provider,request_hash,reserved_usd,units)
 values(j.organization_id,j.id,j.campaign_id,j.opportunity_id,p_key,p_provider,p_hash,p_max,p_units) returning * into o;
 return to_jsonb(o);
end $$;
create or replace function private.operational_status() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not exists(select 1 from public.memberships where user_id=auth.uid()) then raise exception 'authentication_required'; end if;
 return jsonb_build_object('limit_usd',(select case when dollar_limits_enabled then limit_usd::text else 'Unlimited' end from public.budget where id=1), 'dollar_limits_enabled',(select dollar_limits_enabled from public.budget where id=1),
 'live_enabled',(select live_enabled from public.budget where id=1),
 'spent_usd',(select coalesce(sum(actual_usd),0)::text from public.provider_operations where organization_id in(select organization_id from public.memberships where user_id=auth.uid())),
 'reserved_usd',(select coalesce(sum(reserved_usd),0)::text from public.provider_operations where actual_usd is null and organization_id in(select organization_id from public.memberships where user_id=auth.uid())),
 'explorium_units',(select coalesce(sum(coalesce(private.verified_explorium_units(o),o.units)),0) from public.provider_operations o where provider='explorium' and organization_id in(select organization_id from public.memberships where user_id=auth.uid())),
 'explorium_reserved_maxima',(select coalesce(sum(units),0) from public.provider_operations where provider='explorium' and organization_id in(select organization_id from public.memberships where user_id=auth.uid())),
 'worker_seen_at',(select max(seen_at) from public.worker_heartbeats), 'sending_enabled',false);
end $$;
commit;
