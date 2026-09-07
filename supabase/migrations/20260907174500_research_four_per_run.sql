-- Research every discovered company. A run now requests four companies, enriches all four and
-- researches all four: 2 discovery + 2 intent credits each, 16 verified-trial credits per run.
-- Only the research_limit bound and the stored profile change; all other logic is the exact
-- definition read from the live database before this migration.
CREATE OR REPLACE FUNCTION public.ingest_company_discovery(p_job uuid, p_token uuid, p_candidates jsonb, p_report jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
 if research_limit not between 0 and 4 then raise exception 'research_limit';end if;
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
end $function$;

update public.workflow_profiles
 set profile=jsonb_set(jsonb_set(profile,'{maxResearch}','4'::jsonb),'{maxCandidates}','4'::jsonb)
 where profile->>'version'='9';
