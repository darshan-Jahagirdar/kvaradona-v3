-- Cross-run company observations link discovery jobs to existing company opportunities.
-- Unlike source/tender observations, their job and opportunity may belong to different campaigns.
create table public.company_discovery_observations (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,campaign_id uuid not null,
 opportunity_id uuid not null,job_id uuid not null,source text not null default 'apollo',external_id text not null,
 candidate jsonb not null,changed boolean not null default false,observed_at timestamptz not null default now(),
 unique(job_id,external_id),
 foreign key(organization_id,opportunity_id) references public.opportunities(organization_id,id),
 foreign key(organization_id,campaign_id,job_id) references public.jobs(organization_id,campaign_id,id)
);
create index company_discovery_identity on public.company_discovery_observations(organization_id,external_id,observed_at desc);
create index company_discovery_run on public.company_discovery_observations(campaign_id);
alter table public.company_discovery_observations enable row level security;
revoke all on public.company_discovery_observations from public,anon,authenticated;
grant select on public.company_discovery_observations to authenticated;
grant all on public.company_discovery_observations to service_role;
create policy member_read on public.company_discovery_observations for select to authenticated using(organization_id in(select organization_id from public.memberships where user_id=(select auth.uid())));
create function public.ingest_company_discovery(p_job uuid,p_token uuid,p_candidates jsonb,p_report jsonb) returns boolean language plpgsql security invoker set search_path='' as $$
declare j public.jobs;c jsonb;oid uuid;packet jsonb;created integer:=0;reused integer:=0;scheduled integer:=0;research_limit integer;prior jsonb;
begin
 select * into j from public.jobs where id=p_job for update;
 if not found then return false;end if;
 if j.status='done' and j.attempt_token=p_token then return true;end if;
 if j.stage<>'S02' or j.status<>'running' or j.attempt_token is distinct from p_token or j.lease_until<=now() then return false;end if;
 perform 1 from public.organizations where id=j.organization_id for update;
 perform 1 from public.campaigns where id=j.campaign_id and not paused for update;
 if not found then return false;end if;
 if jsonb_typeof(p_candidates) is distinct from 'array' or jsonb_array_length(p_candidates)>5 then raise exception 'candidate_limit';end if;
 research_limit:=coalesce((p_report->>'maxResearch')::integer,0);
 if research_limit not between 0 and 3 then raise exception 'research_limit';end if;
 -- One five-company slice per campaign; replay of the same completed job is handled above.
 if exists(select 1 from public.company_discovery_observations where campaign_id=j.campaign_id) then raise exception 'company_batch_already_ingested';end if;
 for c in select * from jsonb_array_elements(p_candidates) loop
  if c->>'source' is distinct from 'apollo' or coalesce(c#>>'{providerCompany,id}','')='' or coalesce(c#>>'{providerCompany,name}','')='' then raise exception 'company_identity_required';end if;
  if exists(select 1 from public.company_discovery_observations where job_id=j.id and external_id=c#>>'{providerCompany,id}') then continue;end if;
  select o.id,o.packet into oid,prior from public.opportunities o where o.organization_id=j.organization_id and o.packet->>'mode'=p_report->>'mode' and (
   o.packet#>>'{candidate,providerCompany,id}'=c#>>'{providerCompany,id}' or (
    c#>>'{providerCompany,domain}' is not null and
    coalesce(o.packet#>>'{candidate,providerCompany,domain}',o.packet#>>'{research,accountHost}')=c#>>'{providerCompany,domain}' and
    lower(coalesce(o.packet#>>'{candidate,providerCompany,name}',o.packet#>>'{research,company}'))=lower(c#>>'{providerCompany,name}')
   )) order by o.created_at limit 1;
  if oid is null then
   packet:=jsonb_build_object('candidate',c,'evidence','[]'::jsonb,'state','company_assessment_pending','mode',p_report->>'mode','notes',jsonb_build_array('Company identified by Apollo. Buying intent and service need remain unverified.'));
   insert into public.opportunities(organization_id,campaign_id,event_key,state,packet) values(j.organization_id,j.campaign_id,c->>'eventKey','company_assessment_pending',packet) returning id into oid;
   created:=created+1;
   if scheduled<research_limit and c#>>'{providerCompany,icp,status}'<>'mismatch' and c#>>'{providerCompany,domain}' is not null then
    insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
    values(j.organization_id,j.campaign_id,oid,oid::text||':S04:1','S04',md5(packet::text),1,'1','12',packet);
    scheduled:=scheduled+1;
   end if;
  else reused:=reused+1;end if;
  insert into public.company_discovery_observations(organization_id,campaign_id,opportunity_id,job_id,external_id,candidate,changed)
  values(j.organization_id,j.campaign_id,oid,j.id,c#>>'{providerCompany,id}',c,prior is not null and ((prior#>'{candidate,providerCompany}')-'observedAt') is distinct from ((c->'providerCompany')-'observedAt'));
 end loop;
 if not public.complete_job(p_job,p_token,p_report||jsonb_build_object('newCompanies',created,'reusedCompanies',reused,'researchQueued',scheduled),null) then raise exception 'ownership_lost';end if;
 return true;
end $$;
revoke execute on function public.ingest_company_discovery(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.ingest_company_discovery(uuid,uuid,jsonb,jsonb) to service_role;
create or replace function private.start_workflow(p_organization uuid,p_request uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.workflow_runs; cid uuid; run_profile jsonb; payload jsonb; idx integer; search_page integer; committed numeric; cap numeric;
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
 if not exists(select 1 from public.provider_limits where provider='apollo' and verified_at is not null and free_units>=1 and (probe_enabled or (authenticated and usable))) then raise exception 'provider_unverified';end if;
 if (select coalesce(sum(units),0) from public.provider_operations where provider='apollo') >= (select free_units from public.provider_limits where provider='apollo') then raise exception 'free_quota_unverified_or_exhausted';end if;
 -- Each explicit click authorizes an hour of work using previously verified endpoints.
 -- Keep ambiguous charges, cumulative dollar limits and Apollo allowance intact.
 update public.provider_limits set expires_at=now()+interval '1 hour' where provider in('openai','brave','apollo') and verified_at is not null and (probe_enabled or (authenticated and usable));
 select w.profile into run_profile from public.workflow_profiles w where id='focused-v1';
 if run_profile is null then raise exception 'workflow_profile_missing'; end if;
 -- Advance only after a successfully ingested Apollo page, so a failed access probe is not treated as discovery.
 select coalesce(max((j.payload#>>'{groups,0,page}')::integer),0)+1 into search_page from public.jobs j join public.stage_runs s on s.job_id=j.id where j.organization_id=p_organization and j.stage='S02' and j.payload#>>'{groups,0,source}'='apollo';
 if search_page>500 then raise exception 'company_page_limit';end if;
 run_profile:=jsonb_set(run_profile,'{groups,0,page}',to_jsonb(search_page));
 insert into public.campaigns(organization_id,name,version,profile,paused) values(p_organization,run_profile->>'name',(run_profile->>'version')::integer,run_profile,false) returning id into cid;
 insert into public.workflow_runs(organization_id,campaign_id,request_key,requested_by) values(p_organization,cid,p_request,auth.uid()) returning * into r;
 for idx in 0..jsonb_array_length(run_profile->'groups')-1 loop
  payload:=run_profile||jsonb_build_object('asOf',now(),'groupIndex',idx,'seenTheirStackIds','[]'::jsonb);
  insert into public.jobs(organization_id,campaign_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
  values(p_organization,cid,r.id::text||':discovery:'||idx,'S02',md5(payload::text),(run_profile->>'version')::integer,'1','12',payload);
 end loop;
 update public.campaigns set discovery_cursor=jsonb_array_length(run_profile->'groups') where id=cid;
 return to_jsonb(r)||jsonb_build_object('created',true);
end $$;

update public.workflow_profiles set profile='{"version":7,"name":"Apollo companies · US pilot","sendingEnabled":false,"maxResearch":3,"maxCandidates":5,"explorationShare":0.2,"icp":{"employeeRanges":["1,500","501,10000"],"regions":["US","Europe","Australia","Asia"],"industries":null,"revenue":null,"exclusions":null},"pilot":"US headquarters only for the initial pilot; full ICP geography remains US, Europe, Australia and Asia.","groups":[{"source":"apollo","region":"US","country":"US","language":"en","page":1,"query":""}]}'::jsonb where id='focused-v1';
