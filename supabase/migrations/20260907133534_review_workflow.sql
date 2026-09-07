-- Bounded, authenticated workflow launch. Provider dollar/unit caps are never reset.
create table public.workflow_profiles (id text primary key,profile jsonb not null);
alter table public.workflow_profiles enable row level security;
revoke all on public.workflow_profiles from public,anon,authenticated;
grant all on public.workflow_profiles to service_role;
insert into public.workflow_profiles values ('focused-v1','{"version":6,"name":"Focused needs · four demand searches and one exploration","sendingEnabled":false,"maxResearch":1,"explorationShare":0.2,"groups":[{"source":"brave","region":"US","country":"US","language":"en","query":"(\"CRM implementation\" OR \"CRM migration\") (\"request for proposal\" OR \"seeking a partner\") -template -guide -sample"},{"source":"brave","region":"Europe","country":"GB","language":"en","query":"(\"CRM\" OR \"workflow automation\") (\"invites proposals\" OR \"invitation to tender\") -template -guide -training"},{"source":"brave","region":"Australia","country":"AU","language":"en","query":"(\"website redesign\" OR \"website development\") (\"request for proposal\" OR \"invites tenders\") -template -guide"},{"source":"brave","region":"Asia","country":"SG","language":"en","query":"(\"CRM implementation\" OR \"workflow automation\") (\"request for proposal\" OR \"seeking implementation partner\") -template -guide"},{"source":"brave","region":"US","country":"US","language":"en","query":"\"HubSpot\" (\"migration\" OR \"lead routing\" OR \"integration\") \"revenue operations\" -template -guide -\"all openings\""}]}');
create table public.workflow_runs (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations,
 campaign_id uuid not null unique references public.campaigns,request_key uuid not null,
 requested_by uuid not null references auth.users,created_at timestamptz not null default now(),
 unique(organization_id,request_key)
);
alter table public.workflow_runs enable row level security;
revoke all on public.workflow_runs from public,anon,authenticated;
grant select on public.workflow_runs to authenticated;
grant all on public.workflow_runs to service_role;
create policy member_read on public.workflow_runs for select to authenticated using(organization_id in(select organization_id from public.memberships where user_id=(select auth.uid())));
create function private.start_workflow(p_organization uuid,p_request uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.workflow_runs; cid uuid; run_profile jsonb; payload jsonb; idx integer; committed numeric; cap numeric;
begin
 if auth.uid() is null or not exists(select 1 from public.memberships where organization_id=p_organization and user_id=auth.uid()) then raise exception 'membership_required'; end if;
 if p_request is null then raise exception 'request_required'; end if;
 -- Serialize launches across tabs/reviewers for this organization.
 perform 1 from public.organizations where id=p_organization for update;
 select * into r from public.workflow_runs where organization_id=p_organization and request_key=p_request;
 if found then return to_jsonb(r)||jsonb_build_object('created',false); end if;
 select w.* into r from public.workflow_runs w where w.organization_id=p_organization and exists(select 1 from public.jobs j where j.campaign_id=w.campaign_id and j.status in('queued','running')) order by w.created_at desc limit 1;
 if found then return to_jsonb(r)||jsonb_build_object('created',false); end if;
 select limit_usd into cap from public.budget where id=1 and live_enabled for update;
 if cap is null then raise exception 'live_disabled'; end if;
 select coalesce(sum(coalesce(actual_usd,reserved_usd)),0) into committed from public.provider_operations;
 if cap>2 or committed+0.025>cap then raise exception 'budget_paused'; end if;
 if (select count(*) from public.provider_limits l where l.provider in('openai','brave') and l.verified_at is not null and (l.probe_enabled or (l.authenticated and l.usable)) and exists(select 1 from public.provider_operations o where o.provider=l.provider and o.state='succeeded' and o.actual_usd is not null))<>2 then raise exception 'provider_unverified'; end if;
 -- Each explicit click authorizes an hour of work using previously verified endpoints.
 -- Keep ambiguous charges, cumulative dollar limits and Apollo allowance intact.
 update public.provider_limits set expires_at=now()+interval '1 hour' where provider in('openai','brave','apollo') and verified_at is not null and (probe_enabled or (authenticated and usable));
 select w.profile into run_profile from public.workflow_profiles w where id='focused-v1';
 if run_profile is null then raise exception 'workflow_profile_missing'; end if;
 insert into public.campaigns(organization_id,name,version,profile,paused) values(p_organization,run_profile->>'name',6,run_profile,false) returning id into cid;
 insert into public.workflow_runs(organization_id,campaign_id,request_key,requested_by) values(p_organization,cid,p_request,auth.uid()) returning * into r;
 for idx in 0..jsonb_array_length(run_profile->'groups')-1 loop
  payload:=run_profile||jsonb_build_object('asOf',now(),'groupIndex',idx,'seenTheirStackIds','[]'::jsonb);
  insert into public.jobs(organization_id,campaign_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
  values(p_organization,cid,r.id::text||':discovery:'||idx,'S02',md5(payload::text),6,'1','11',payload);
 end loop;
 update public.campaigns set discovery_cursor=jsonb_array_length(run_profile->'groups') where id=cid;
 return to_jsonb(r)||jsonb_build_object('created',true);
end $$;
create function public.start_workflow(p_organization uuid,p_request uuid) returns jsonb language sql security invoker set search_path='' as $$ select private.start_workflow(p_organization,p_request); $$;
revoke execute on function private.start_workflow(uuid,uuid),public.start_workflow(uuid,uuid) from public,anon;
grant execute on function private.start_workflow(uuid,uuid),public.start_workflow(uuid,uuid) to authenticated;
-- Read-only worker state, scoped by membership. The POC uses one shared laptop worker.
create function private.workflow_worker_status() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not exists(select 1 from public.memberships where user_id=auth.uid()) then raise exception 'membership_required'; end if;
 return jsonb_build_object('online',exists(select 1 from public.worker_heartbeats where status='running' and seen_at>now()-interval '90 seconds'),'seenAt',(select max(seen_at) from public.worker_heartbeats),'sendingEnabled',false);
end $$;
create function public.workflow_worker_status() returns jsonb language sql security invoker set search_path='' as $$ select private.workflow_worker_status(); $$;
revoke execute on function private.workflow_worker_status(),public.workflow_worker_status() from public,anon;
grant execute on function private.workflow_worker_status(),public.workflow_worker_status() to authenticated;
