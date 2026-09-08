-- User authorized $3 cumulative OpenAI/Brave spending and 501+ for one bounded test.
-- Keep all historical spending, reservations, per-campaign/opportunity limits and provider credits.
alter table public.budget drop constraint budget_limit_usd_check;
alter table public.budget add constraint budget_limit_usd_check check(limit_usd between 0 and 3);
update public.budget set limit_usd=3,verification=verification || '{"authorizedCapUsd":3,"authorization":"User requested $3 cumulative OpenAI/Brave cap on 2026-09-08; no spending reset"}'::jsonb where id=1;
update public.provider_limits set limit_usd=2.80 where provider='openai';
CREATE OR REPLACE FUNCTION private.start_workflow(p_organization uuid, p_request uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
 if cap>3 or committed+0.025>cap then raise exception 'budget_paused'; end if;
 if (select count(*) from public.provider_limits l where l.provider in('openai','brave') and l.verified_at is not null and (l.probe_enabled or (l.authenticated and l.usable)) and exists(select 1 from public.provider_operations o where o.provider=l.provider and o.state='succeeded' and o.actual_usd is not null))<>2 then raise exception 'provider_unverified'; end if;
 if not exists(select 1 from public.provider_limits where provider='explorium' and verified_at is not null and free_units>=16 and (probe_enabled or (authenticated and usable))) then raise exception 'provider_unverified';end if;
 if (select coalesce(sum(coalesce(private.verified_explorium_units(provider_operations),units)),0) from public.provider_operations where provider='explorium')+16 > (select free_units from public.provider_limits where provider='explorium') then raise exception 'free_quota_unverified_or_exhausted';end if;
 if not exists(select 1 from public.provider_limits where provider='explorium' and evidence::jsonb->>'kind'='verified_trial' and (evidence::jsonb->>'trialValidUntil')::timestamptz>now()) then raise exception 'explorium_trial_verification_expired';end if;
 if exists(select 1 from public.provider_operations held_op where held_op.provider='explorium' and (held_op.state in('dispatched','ambiguous') or (held_op.state='succeeded' and private.verified_explorium_units(held_op) is null))) then raise exception 'explorium_credit_accounting_hold';end if;
 -- Each explicit click authorizes an hour of work using previously verified endpoints.
 -- Keep ambiguous charges, cumulative dollar limits and Apollo allowance intact.
 update public.provider_limits set expires_at=now()+interval '1 hour' where provider in('openai','brave','apollo','explorium') and verified_at is not null and (probe_enabled or (authenticated and usable));
 select w.profile into run_profile from public.workflow_profiles w where id='focused-v1';
 if run_profile is null then raise exception 'workflow_profile_missing'; end if;
 if run_profile->>'version'<>'11' or run_profile#>>'{groups,0,searchDefinition,version}' is distinct from '11' or run_profile#>>'{groups,0,searchDefinition,source}' is distinct from 'explorium' then raise exception 'intent_search_definition_required';end if;
 -- Continue only an identical frozen definition after successful ingestion. Changed filters/topics/page configuration start fresh.
 select s.output#>>'{providerResult,nextCursor}' into cursor_value from public.jobs j join public.stage_runs s on s.job_id=j.id
 where j.organization_id=p_organization and j.stage='S02' and j.input_version=(run_profile->>'version')::integer and j.payload#>>'{groups,0,source}'='explorium' and j.status='done'
 and j.payload#>'{groups,0,searchDefinition}'=run_profile#>'{groups,0,searchDefinition}'
 and s.output#>'{providerResult,searchDefinition}'=run_profile#>'{groups,0,searchDefinition}'
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
end $function$;
update public.workflow_profiles set profile='{"version":11,"name":"Six-topic intent \u00b7 company research","sendingEnabled":false,"maxResearch":4,"maxCandidates":4,"icp":{"version":11,"employeeRange":{"min":501,"max":10000},"countries":[{"code":"IN","name":"India"},{"code":"US","name":"United States"},{"code":"GB","name":"United Kingdom"},{"code":"AU","name":"Australia"},{"code":"NZ","name":"New Zealand"},{"code":"AE","name":"United Arab Emirates"},{"code":"SG","name":"Singapore"}],"buyerTitles":["CMO","VP Marketing","VP Sales","CEO","Operations","Sales Manager","Sales Head"],"industries":["IT & Services","Construction","Marketing & Advertising","Real Estate","Healthcare","Consulting","Software","Consumer Services","Automotive","Education","Design","Hospitality"],"intentTopics":["HubSpot","Monday.com","SEO","Website","CRM","Marketing Automation"]},"activeIntentTopics":["media & advertising: hubspot (hubs)","media & advertising: hubspot marketing hub","technology: monday.com","search marketing: search engine optimization (seo)","business solutions: corporate website","website publishing: website design","web: replatform website","it management: website performance","crm: customer relationship management (crm)","crm: marketing automation"],"discoverySetup":{"ready":true,"code":"intent_topics_configured","reason":"Six-topic intent search configured. First multi-topic live outcome remains unmeasured."},"coverage":"This bounded test targets 501\u201310,000 employees, matching the configured provider bands. Companies below 501 are outside this test.","groups":[{"source":"explorium","region":"unspecified","country":"US","language":"en","page":1,"query":"","searchDefinition":{"version":11,"source":"explorium","mode":"full","pageSize":4,"filters":{"country_code":{"values":["in","us","gb","au","nz","ae","sg"]},"company_size":{"values":["501-1000","1001-5000","5001-10000"]},"linkedin_category":{"values":["it services and it consulting","construction","advertising services","real estate","hospitals and health care","business consulting and services","operations consulting","software development","consumer services","motor vehicle manufacturing","retail motor vehicles","wholesale motor vehicles and parts","motor vehicle parts manufacturing","education","education management","higher education","education administration programs","primary and secondary education","design services","hospitality"]},"business_intent_topics":{"topics":["media & advertising: hubspot (hubs)","media & advertising: hubspot marketing hub","technology: monday.com","search marketing: search engine optimization (seo)","business solutions: corporate website","website publishing: website design","web: replatform website","it management: website performance","crm: customer relationship management (crm)","crm: marketing automation"]}}}}]}'::jsonb where id='focused-v1';
