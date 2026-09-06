-- Additive V3-only migration. Never apply before project isolation/backup checks.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create table public.organizations (
 id uuid primary key default gen_random_uuid(), name text not null, created_at timestamptz not null default now()
);
create table public.memberships (
 organization_id uuid not null references public.organizations, user_id uuid not null references auth.users,
 role text not null check(role in ('admin','reviewer')), primary key(organization_id,user_id)
);
create index memberships_user on public.memberships(user_id,organization_id);
create table public.campaigns (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations,
 version integer not null default 1 check(version > 0), name text not null, profile jsonb not null,
 paused boolean not null default true, created_at timestamptz not null default now(), unique(organization_id,id)
);
create table public.opportunities (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, campaign_id uuid not null,
 event_key text not null, revision integer not null default 1, state text not null default 'discovered',
 packet jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(organization_id,id), unique(organization_id,campaign_id,id), unique(organization_id,campaign_id,event_key),
 foreign key(organization_id,campaign_id) references public.campaigns(organization_id,id)
);
create table public.evidence (
 id uuid primary key, organization_id uuid not null, opportunity_id uuid not null,
 document jsonb not null, created_at timestamptz not null default now(), unique(organization_id,id),
 foreign key(organization_id,opportunity_id) references public.opportunities(organization_id,id)
);
create table public.jobs (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, campaign_id uuid not null,
 opportunity_id uuid, business_key text not null, stage text not null, input_hash text not null,
 input_version integer not null, schema_version text not null, prompt_version text not null, payload jsonb not null,
 status text not null default 'queued' check(status in ('queued','running','done','failed','blocked')),
 priority integer not null default 10, due_at timestamptz not null default now(),
 attempts integer not null default 0, attempt_token uuid, lease_until timestamptz, worker_id text, error text,
 created_at timestamptz not null default now(), unique(organization_id,id), unique(organization_id,business_key),
 foreign key(organization_id,campaign_id) references public.campaigns(organization_id,id),
 foreign key(organization_id,campaign_id,opportunity_id) references public.opportunities(organization_id,campaign_id,id)
);
create index jobs_due on public.jobs(priority,due_at) where status in ('queued','running');
create table public.stage_runs (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, job_id uuid not null,
 output jsonb not null, completed_at timestamptz not null default now(), unique(job_id),
 foreign key(organization_id,job_id) references public.jobs(organization_id,id)
);
-- One shared dollar envelope across all campaigns/providers: user-authorized initial $1.
create table public.budget (
 id integer primary key check(id=1), limit_usd numeric(12,8) not null check(limit_usd between 0 and 1),
 live_enabled boolean not null default false, verification jsonb not null default '{}'
);
insert into public.budget(id,limit_usd) values(1,1.00);
create table public.provider_limits (
 provider text primary key, limit_usd numeric(12,8) not null check(limit_usd>=0),
 free_units integer not null default 0 check(free_units>=0), verified_at timestamptz, expires_at timestamptz,
 evidence text, probe_enabled boolean not null default false, authenticated boolean not null default false, usable boolean not null default false
);
insert into public.provider_limits(provider,limit_usd) values
 ('openai',0.90),('brave',0.10),('apollo',0),('theirstack',0),('predictleads',0),('hirebase',0),('sam',0),('pagespeed',0);
create table public.provider_operations (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, job_id uuid not null,
 campaign_id uuid not null, opportunity_id uuid, operation_key text not null, provider text not null references public.provider_limits,
 request_hash text not null, state text not null default 'reserved' check(state in ('reserved','dispatched','succeeded','ambiguous')),
 reserved_usd numeric(12,8) not null check(reserved_usd>=0), actual_usd numeric(12,8) check(actual_usd>=0),
 units integer not null check(units>=0), response jsonb, usage jsonb, dispatched_at timestamptz,
 created_at timestamptz not null default now(), unique(organization_id,operation_key),
 foreign key(organization_id,job_id) references public.jobs(organization_id,id),
 foreign key(organization_id,campaign_id) references public.campaigns(organization_id,id),
 foreign key(organization_id,opportunity_id) references public.opportunities(organization_id,id)
);
create index operations_budget on public.provider_operations(provider,campaign_id,opportunity_id);
create table public.schedules (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, campaign_id uuid not null,
 next_due timestamptz not null, interval_seconds integer not null check(interval_seconds>=300), enabled boolean not null default false,
 foreign key(organization_id,campaign_id) references public.campaigns(organization_id,id)
);
create table public.worker_heartbeats (
 id text primary key, seen_at timestamptz not null default now(), status text not null
);
create table public.relationships (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations,
 account_host text not null, status text not null check(status in ('clear','customer','active_deal','recent_outreach','replied','opt_out','bounce')),
 owner text, observed_at timestamptz not null default now(), unique(organization_id,account_host)
);
create table public.reviews (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, opportunity_id uuid not null,
 revision integer not null, request_key uuid not null, reviewer_id uuid not null references auth.users,
 action text not null check(action in ('edit','defer','reject','research','approve')), note text not null,
 snapshot jsonb not null, created_at timestamptz not null default now(), unique(organization_id,request_key),
 foreign key(organization_id,opportunity_id) references public.opportunities(organization_id,id)
);
-- Named users only. Membership cannot be created or changed by browser roles.
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
create policy memberships_read on public.memberships for select to authenticated using(user_id=(select auth.uid()));
create policy organizations_read on public.organizations for select to authenticated using(id in(select organization_id from public.memberships where user_id=(select auth.uid())));
revoke all on public.organizations,public.memberships from anon,authenticated;
grant select on public.organizations,public.memberships to authenticated;

do $$ declare t text; begin
 foreach t in array array['campaigns','opportunities','evidence','jobs','stage_runs','provider_operations','schedules','relationships','reviews'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon, authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 execute format('create policy member_read on public.%I for select to authenticated using (organization_id in (select organization_id from public.memberships where user_id=(select auth.uid())))',t);
 end loop;
 foreach t in array array['budget','provider_limits','worker_heartbeats'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon, authenticated',t);
 end loop;
end $$;
grant all on public.organizations,public.memberships,public.campaigns,public.opportunities,public.evidence,public.jobs,public.stage_runs,public.budget,public.provider_limits,public.provider_operations,public.schedules,public.worker_heartbeats,public.relationships,public.reviews to service_role;
revoke all on public.organizations,public.memberships from anon;

create function public.claim_job(p_worker text) returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.jobs;
begin
 -- Expired final attempts become visible terminal failures, never infinite retry loops.
 update public.jobs set status='failed',error='attempt_limit' where status='running' and lease_until<now() and attempts>=3;
 select q.* into j from public.jobs q join public.campaigns c on c.id=q.campaign_id
 where not c.paused and q.attempts<3 and ((q.status='queued' and q.due_at<=now()) or (q.status='running' and q.lease_until<now()))
 order by q.priority,q.due_at for update of q skip locked limit 1;
 if not found then return null; end if;
 update public.jobs set status='running',attempts=attempts+1,attempt_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',worker_id=p_worker
 where id=j.id returning * into j;
 return to_jsonb(j);
end $$;
create function public.renew_job(p_job uuid,p_token uuid) returns boolean language plpgsql security invoker set search_path='' as $$
begin
 update public.jobs set lease_until=now()+interval '90 seconds' where id=p_job and attempt_token=p_token and status='running' and lease_until>now()
 and exists(select 1 from public.campaigns c where c.id=campaign_id and not c.paused)
 and (opportunity_id is null or exists(select 1 from public.opportunities o where o.id=opportunity_id and o.revision=input_version));
 return found;
end $$;
create function public.fail_job(p_job uuid,p_token uuid,p_reason text,p_retry boolean) returns boolean language plpgsql security invoker set search_path='' as $$
begin
 update public.jobs set status=case when p_retry and attempts<3 then 'queued' else 'blocked' end,
 error=left(p_reason,500),due_at=now()+interval '60 seconds',lease_until=null
 where id=p_job and attempt_token=p_token and status='running' and lease_until>now();
 return found;
end $$;
create function public.reserve_operation(p_job uuid,p_token uuid,p_key text,p_provider text,p_hash text,p_max numeric,p_units integer) returns jsonb
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
 if p_max is null or p_units is null or p_max<0 or p_units<0 or p_max>0.25 then raise exception 'invalid_reservation'; end if;
 if not b.live_enabled then raise exception 'live_disabled'; end if;
 select * into l from public.provider_limits where provider=p_provider;
 if not found or not (l.probe_enabled or (l.authenticated and l.usable)) or l.verified_at is null or l.expires_at<=now() or l.expires_at is null then raise exception 'provider_unverified'; end if;
 select coalesce(sum(coalesce(actual_usd,reserved_usd)),0),
 coalesce(sum(coalesce(actual_usd,reserved_usd)) filter(where provider=p_provider),0),
 coalesce(sum(coalesce(actual_usd,reserved_usd)) filter(where campaign_id=j.campaign_id),0),
 coalesce(sum(coalesce(actual_usd,reserved_usd)) filter(where opportunity_id=j.opportunity_id),0),
 coalesce(sum(units) filter(where provider=p_provider),0)
 into total,provider_total,campaign_total,opportunity_total,consumed from public.provider_operations;
 if total+p_max>b.limit_usd or provider_total+p_max>l.limit_usd or campaign_total+p_max>0.90 or (j.opportunity_id is not null and opportunity_total+p_max>0.25) then raise exception 'budget_paused'; end if;
 if p_provider not in ('openai','brave') and (p_max<>0 or consumed+p_units>l.free_units) then raise exception 'free_quota_unverified_or_exhausted'; end if;
 insert into public.provider_operations(organization_id,job_id,campaign_id,opportunity_id,operation_key,provider,request_hash,reserved_usd,units)
 values(j.organization_id,j.id,j.campaign_id,j.opportunity_id,p_key,p_provider,p_hash,p_max,p_units) returning * into o;
 return to_jsonb(o);
end $$;
create function public.dispatch_operation(p_operation uuid,p_job uuid,p_token uuid) returns boolean language plpgsql security invoker set search_path='' as $$
begin
 if not public.renew_job(p_job,p_token) then return false; end if;
 update public.provider_operations set state='dispatched',dispatched_at=now() where id=p_operation and job_id=p_job and state='reserved';
 return found;
end $$;
-- Accept late response accounting without permitting a stale worker to publish stage output.
create function public.record_operation(p_operation uuid,p_hash text,p_response jsonb,p_usage jsonb,p_actual numeric) returns boolean
 language plpgsql security invoker set search_path='' as $$
declare o public.provider_operations;
begin
 perform 1 from public.budget where id=1 for update;
 select * into o from public.provider_operations where id=p_operation and request_hash=p_hash for update;
 if not found then raise exception 'operation_missing'; end if;
 if o.state='succeeded' then return true; end if;
 if o.state not in ('dispatched','ambiguous') or p_actual<0 then raise exception 'invalid_operation_settlement'; end if;
 update public.provider_operations set state='succeeded',response=p_response,usage=p_usage,actual_usd=p_actual where id=o.id;
 if p_actual is null or p_actual>o.reserved_usd then update public.budget set live_enabled=false where id=1; end if;
 return true;
end $$;
create function public.complete_job(p_job uuid,p_token uuid,p_output jsonb,p_next jsonb) returns boolean
 language plpgsql security invoker set search_path='' as $$
declare j public.jobs; ev jsonb;
begin
 select * into j from public.jobs where id=p_job for update;
 if not found then return false; end if;
 if j.status='done' and j.attempt_token=p_token then return true; end if;
 if j.status<>'running' or j.attempt_token is distinct from p_token or j.lease_until<=now() then return false; end if;
 if exists(select 1 from public.campaigns where id=j.campaign_id and paused) then return false; end if;
 if j.opportunity_id is not null and not exists(select 1 from public.opportunities where id=j.opportunity_id and organization_id=j.organization_id and revision=j.input_version) then return false; end if;
 if exists(select 1 from public.provider_operations where job_id=j.id and (state<>'succeeded' or actual_usd is null)) then raise exception 'unsettled_operation'; end if;
 insert into public.stage_runs(organization_id,job_id,output) values(j.organization_id,j.id,p_output);
 if j.opportunity_id is not null then
  update public.opportunities set packet=p_output, state=coalesce(p_output->>'state','researching'),updated_at=now() where id=j.opportunity_id and organization_id=j.organization_id;
  for ev in select * from jsonb_array_elements(coalesce(p_output->'evidence','[]')) loop
   insert into public.evidence(id,organization_id,opportunity_id,document) values((ev->>'id')::uuid,j.organization_id,j.opportunity_id,ev) on conflict(id) do nothing;
   if not exists(select 1 from public.evidence where id=(ev->>'id')::uuid and organization_id=j.organization_id and opportunity_id=j.opportunity_id and document=ev) then raise exception 'evidence_conflict'; end if;
  end loop;
 end if;
 if p_next is not null then
 insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
 values(j.organization_id,j.campaign_id,j.opportunity_id,p_next->>'business_key',p_next->>'stage',p_next->>'input_hash',j.input_version,j.schema_version,j.prompt_version,p_output)
 on conflict(organization_id,business_key) do nothing;
 end if;
 update public.jobs set status='done',lease_until=null where id=j.id;
 return true;
end $$;
-- Scheduler advances to one future tick, coalescing laptop downtime.
create function public.tick_schedules() returns integer language plpgsql security invoker set search_path='' as $$
declare s public.schedules; c public.campaigns; n integer:=0;
begin
 for s in select q.* from public.schedules q join public.campaigns campaign_row on campaign_row.id=q.campaign_id where q.enabled and q.next_due<=now() and not campaign_row.paused for update of q skip locked loop
  select * into c from public.campaigns where id=s.campaign_id;
  insert into public.jobs(organization_id,campaign_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
  values(s.organization_id,s.campaign_id,s.id::text||':'||s.next_due::text,'S02',md5(c.profile::text),c.version,'1','1',c.profile) on conflict(organization_id,business_key) do nothing;
  update public.schedules set next_due=now()+make_interval(secs=>s.interval_seconds) where id=s.id;
  n:=n+1;
 end loop; return n;
end $$;

-- Only callable through the authenticated wrapper; validate membership and optimistic revision.
create function private.review_opportunity(p_id uuid,p_revision integer,p_request uuid,p_action text,p_note text,p_draft jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare o public.opportunities; r public.reviews; snap jsonb;
begin
 if auth.uid() is null then raise exception 'authentication_required'; end if;
 select * into o from public.opportunities where id=p_id for update;
 if not found or not exists(select 1 from public.memberships where organization_id=o.organization_id and user_id=auth.uid()) then raise exception 'not_found'; end if;
 select * into r from public.reviews where organization_id=o.organization_id and request_key=p_request;
 if found then
  if r.opportunity_id<>p_id or r.reviewer_id<>auth.uid() then raise exception 'request_key_conflict'; end if;
  return to_jsonb(r);
 end if;
 if o.revision<>p_revision then raise exception 'stale_version'; end if;
 if p_action='approve' then raise exception 'sending_disabled_provider_pending'; end if;
 if p_action is null or p_action not in ('edit','defer','reject','research') or p_note is null or length(trim(p_note))=0 then raise exception 'review_reason_required'; end if;
 snap:=o.packet;
 if p_action='edit' then
  if p_draft is null or jsonb_typeof(p_draft)<>'object' or p_draft->>'body' is null or p_draft->>'subject' is null or length(p_draft->>'body') not between 1 and 6000 or length(p_draft->>'subject') not between 1 and 200 then raise exception 'invalid_draft'; end if;
  snap:=jsonb_set(snap,'{draft}',p_draft)-'draftReview';
 end if;
 snap:=jsonb_set(snap,'{state}',to_jsonb(case p_action when 'edit' then 'review_required' when 'research' then 'research_requested' else p_action end));
 insert into public.reviews(organization_id,opportunity_id,revision,request_key,reviewer_id,action,note,snapshot)
 values(o.organization_id,o.id,o.revision,p_request,auth.uid(),p_action,p_note,o.packet) returning * into r;
 update public.opportunities set packet=snap,revision=revision+1,state=snap->>'state',updated_at=now() where id=o.id;
 return to_jsonb(r);
end $$;
create function public.review_opportunity(p_id uuid,p_revision integer,p_request uuid,p_action text,p_note text,p_draft jsonb) returns jsonb
 language sql security invoker set search_path='' as $$ select private.review_opportunity(p_id,p_revision,p_request,p_action,p_note,p_draft); $$;
-- Explicit EXECUTE grants: no browser role can claim work or spend money.
do $$ declare f regprocedure; begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('claim_job','renew_job','fail_job','reserve_operation','dispatch_operation','record_operation','complete_job','tick_schedules','review_opportunity') loop
 execute format('revoke execute on function %s from public,anon,authenticated',f);
 execute format('grant execute on function %s to service_role',f);
 end loop;
end $$;
revoke execute on function private.review_opportunity(uuid,integer,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function private.review_opportunity(uuid,integer,uuid,text,text,jsonb) to authenticated;
grant execute on function public.review_opportunity(uuid,integer,uuid,text,text,jsonb) to authenticated;

create function public.ingest_discovery(p_job uuid,p_token uuid,p_candidates jsonb,p_report jsonb) returns boolean language plpgsql security invoker set search_path='' as $$
declare j public.jobs; c jsonb; oid uuid; packet jsonb; n integer:=0;
begin
 select * into j from public.jobs where id=p_job for update;
 if not found then return false; end if;
 if j.status='done' and j.attempt_token=p_token then return true; end if;
 if j.stage<>'S02' or j.status<>'running' or j.attempt_token is distinct from p_token or j.lease_until<=now() then return false; end if;
 if jsonb_array_length(p_candidates)>4 then raise exception 'candidate_limit'; end if;
 for c in select * from jsonb_array_elements(p_candidates) loop
  packet:=jsonb_build_object('candidate',c,'evidence','[]'::jsonb,'state','discovered','mode',p_report->>'mode','notes','[]'::jsonb);
  insert into public.opportunities(organization_id,campaign_id,event_key,packet) values(j.organization_id,j.campaign_id,c->>'eventKey',packet)
  on conflict(organization_id,campaign_id,event_key) do nothing returning id into oid;
  if oid is not null then
   n:=n+1;
   -- Initial verification: research at most one of this discovery run's candidates.
   if n<=1 then
    insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
    values(j.organization_id,j.campaign_id,oid,oid::text||':S04:1','S04',md5(packet::text),1,'1','1',packet);
   end if;
  end if;
 end loop;
 if not public.complete_job(p_job,p_token,p_report,null) then raise exception 'ownership_lost'; end if;
 return true;
end $$;
revoke execute on function public.ingest_discovery(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.ingest_discovery(uuid,uuid,jsonb,jsonb) to service_role;

create function private.operational_status() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not exists(select 1 from public.memberships where user_id=auth.uid()) then raise exception 'authentication_required'; end if;
 return jsonb_build_object('limit_usd',(select limit_usd::text from public.budget where id=1),
 'live_enabled',(select live_enabled from public.budget where id=1),
 'spent_usd',(select coalesce(sum(actual_usd),0)::text from public.provider_operations where organization_id in(select organization_id from public.memberships where user_id=auth.uid())),
 'reserved_usd',(select coalesce(sum(reserved_usd),0)::text from public.provider_operations where actual_usd is null and organization_id in(select organization_id from public.memberships where user_id=auth.uid())),
 'worker_seen_at',(select max(seen_at) from public.worker_heartbeats), 'sending_enabled',false);
end $$;
create function public.operational_status() returns jsonb language sql security invoker set search_path='' as $$ select private.operational_status(); $$;
revoke execute on function private.operational_status(),public.operational_status() from public,anon;
grant execute on function private.operational_status(),public.operational_status() to authenticated;
