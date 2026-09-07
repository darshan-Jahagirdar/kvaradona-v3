-- New provider is disabled until private trial evidence/usage is registered. No credentials or live data here.
insert into public.provider_limits(provider,limit_usd,free_units) values('explorium',0,0) on conflict(provider) do nothing;
create or replace function public.ingest_company_discovery(p_job uuid,p_token uuid,p_candidates jsonb,p_report jsonb) returns boolean language plpgsql security invoker set search_path='' as $$
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
  if c#>>'{providerCompany,domain}' in ('crossover.com','wsj.com','forbes.com','github.com','nytimes.com','higgsfield.ai') then continue;end if;
  if c->>'source' not in ('apollo','explorium') or coalesce(c#>>'{providerCompany,id}','')='' or coalesce(c#>>'{providerCompany,name}','')='' then raise exception 'company_identity_required';end if;
  if exists(select 1 from public.company_discovery_observations where job_id=j.id and external_id=c#>>'{providerCompany,id}') then continue;end if;
  select o.id,o.packet into oid,prior from public.opportunities o where o.organization_id=j.organization_id and o.packet->>'mode'=p_report->>'mode' and (
   (o.packet#>>'{candidate,providerCompany,provider}'=c#>>'{providerCompany,provider}' and o.packet#>>'{candidate,providerCompany,id}'=c#>>'{providerCompany,id}') or (
    c#>>'{providerCompany,domain}' is not null and
    coalesce(o.packet#>>'{candidate,providerCompany,domain}',o.packet#>>'{research,accountHost}')=c#>>'{providerCompany,domain}' and
    lower(coalesce(o.packet#>>'{candidate,providerCompany,name}',o.packet#>>'{research,company}'))=lower(c#>>'{providerCompany,name}')
   )) order by o.created_at limit 1;
  if oid is null then
   packet:=jsonb_build_object('candidate',c,'evidence','[]'::jsonb,'state','company_assessment_pending','mode',p_report->>'mode','notes',jsonb_build_array('Company identified by a data provider. Topic research does not confirm a purchase; original context and service fit require checking.'));
   insert into public.opportunities(organization_id,campaign_id,event_key,state,packet) values(j.organization_id,j.campaign_id,c->>'eventKey','company_assessment_pending',packet) returning id into oid;
   created:=created+1;
   if scheduled<research_limit and (c->>'source'<>'explorium' or (c#>>'{providerCompany,icp,status}'='match' and c#>>'{providerCompany,intent,status}'='provider_reported')) and c#>>'{providerCompany,icp,status}'<>'mismatch' and c#>>'{providerCompany,domain}' is not null then
    insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
    values(j.organization_id,j.campaign_id,oid,oid::text||':S04:1','S04',md5(packet::text),1,'1','12',packet);
    scheduled:=scheduled+1;
   end if;
  else reused:=reused+1;end if;
  insert into public.company_discovery_observations(organization_id,campaign_id,opportunity_id,job_id,source,external_id,candidate,changed)
  values(j.organization_id,j.campaign_id,oid,j.id,c->>'source',c#>>'{providerCompany,id}',c,prior is not null and ((prior#>'{candidate,providerCompany}')-'observedAt') is distinct from ((c->'providerCompany')-'observedAt'));
 end loop;
 if not public.complete_job(p_job,p_token,p_report||jsonb_build_object('newCompanies',created,'reusedCompanies',reused,'researchQueued',scheduled),null) then raise exception 'ownership_lost';end if;
 return true;
end $$;
revoke execute on function public.ingest_company_discovery(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.ingest_company_discovery(uuid,uuid,jsonb,jsonb) to service_role;
create or replace function private.start_workflow(p_organization uuid,p_request uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.workflow_runs; cid uuid; run_profile jsonb; payload jsonb; idx integer; cursor_value text; previous_found boolean; committed numeric; cap numeric;
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
 if not exists(select 1 from public.provider_limits where provider='explorium' and verified_at is not null and free_units>=16 and (probe_enabled or (authenticated and usable))) then raise exception 'provider_unverified';end if;
 if (select coalesce(sum(units),0) from public.provider_operations where provider='explorium')+16 > (select free_units from public.provider_limits where provider='explorium') then raise exception 'free_quota_unverified_or_exhausted';end if;
 if not exists(select 1 from public.provider_limits where provider='explorium' and evidence::jsonb->>'kind'='verified_trial' and (evidence::jsonb->>'trialValidUntil')::timestamptz>now()) then raise exception 'explorium_trial_verification_expired';end if;
 if exists(select 1 from public.provider_operations where provider='explorium' and state='succeeded' and ((usage->>'actualCredits') is null or (usage->>'actualCredits')::numeric>units)) then raise exception 'explorium_credit_accounting_hold';end if;
 -- Each explicit click authorizes an hour of work using previously verified endpoints.
 -- Keep ambiguous charges, cumulative dollar limits and Apollo allowance intact.
 update public.provider_limits set expires_at=now()+interval '1 hour' where provider in('openai','brave','apollo','explorium') and verified_at is not null and (probe_enabled or (authenticated and usable));
 select w.profile into run_profile from public.workflow_profiles w where id='focused-v1';
 if run_profile is null then raise exception 'workflow_profile_missing'; end if;
 -- Continue this profile's verified cursor only; changed profiles start their own search.
 select s.output#>>'{providerResult,nextCursor}' into cursor_value from public.jobs j join public.stage_runs s on s.job_id=j.id
 where j.organization_id=p_organization and j.stage='S02' and j.input_version=(run_profile->>'version')::integer and j.payload#>>'{groups,0,source}'='explorium'
 order by s.completed_at desc limit 1;
 previous_found:=found;
 if previous_found and cursor_value is null then raise exception 'intent_search_exhausted';end if;
 if cursor_value is not null then run_profile:=jsonb_set(run_profile,'{groups,0,nextCursor}',to_jsonb(cursor_value));end if;
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

update public.workflow_profiles set profile='{"version":9,"name":"Pardot intent · full ICP","sendingEnabled":false,"maxResearch":3,"maxCandidates":5,"icp":{"version":9,"employeeRange":{"min":500,"max":10000},"countries":[{"code":"IN","name":"India"},{"code":"US","name":"United States"},{"code":"GB","name":"United Kingdom"},{"code":"AU","name":"Australia"},{"code":"NZ","name":"New Zealand"},{"code":"AE","name":"United Arab Emirates"},{"code":"SG","name":"Singapore"}],"buyerTitles":["CMO","VP Marketing","VP Sales","CEO","Operations","Sales Manager","Sales Head"],"industries":["IT & Services","Construction","Marketing & Advertising","Real Estate","Healthcare","Consulting","Software","Consumer Services","Automotive","Education","Design","Hospitality"],"intentTopics":["HubSpot","Monday.com","SEO","Website","CRM","Marketing Automation"]},"activeIntentTopics":["media & advertising: pardot"],"discoverySetup":{"ready":true,"code":"intent_source_verified","reason":"Explorium/Bombora trial discovery and dated intent enrichment verified. Active pilot: Pardot."},"groups":[{"source":"explorium","region":"unspecified","country":"US","language":"en","page":1,"query":""}]}'::jsonb where id='focused-v1';
