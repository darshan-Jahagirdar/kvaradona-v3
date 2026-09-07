-- No supported automated intent-topic interface has been verified. Block new company discovery
-- before queue creation, provider expiry renewal or reservation. Existing evidence work is intact.
create or replace function private.start_workflow(p_organization uuid,p_request uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare existing public.workflow_runs;
begin
 if auth.uid() is null or not exists(select 1 from public.memberships where organization_id=p_organization and user_id=auth.uid()) then raise exception 'membership_required';end if;
 if p_request is null then raise exception 'request_required';end if;
 select * into existing from public.workflow_runs where organization_id=p_organization and request_key=p_request;
 if found then return to_jsonb(existing)||jsonb_build_object('created',false);end if;
 raise exception 'apollo_intent_access_unverified';
end $$;

update public.workflow_profiles set profile='{"version":8,"name":"ICP and buying intent","sendingEnabled":false,"maxResearch":3,"maxCandidates":5,"icp":{"version":8,"employeeRange":{"min":500,"max":10000},"countries":[{"code":"IN","name":"India"},{"code":"US","name":"United States"},{"code":"GB","name":"United Kingdom"},{"code":"AU","name":"Australia"},{"code":"NZ","name":"New Zealand"},{"code":"AE","name":"United Arab Emirates"},{"code":"SG","name":"Singapore"}],"buyerTitles":["CMO","VP Marketing","VP Sales","CEO","Operations","Sales Manager","Sales Head"],"industries":["IT & Services","Construction","Marketing & Advertising","Real Estate","Healthcare","Consulting","Software","Consumer Services","Automotive","Education","Design","Hospitality"],"intentTopics":["HubSpot","Monday.com","SEO","Website","CRM","Marketing Automation"]},"discoverySetup":{"ready":false,"code":"apollo_intent_access_unverified","reason":"Apollo buying-intent search access and topic mappings need verification. Company-only discovery is paused."}}'::jsonb where id='focused-v1';
