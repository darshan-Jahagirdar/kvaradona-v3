-- Keep previous material notice versions without overwriting evidence or review history.
create table public.opportunity_source_versions (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations,
 opportunity_id uuid not null references public.opportunities,revision integer not null,snapshot jsonb not null,reason text not null,created_at timestamptz not null default now()
);
create table public.quality_labels (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations,
 opportunity_id uuid not null references public.opportunities,revision integer not null,packet_hash text not null,
 reviewer_id uuid not null references auth.users,request_key uuid not null,labels jsonb not null,snapshot jsonb not null,created_at timestamptz not null default now(),
 unique(organization_id,request_key)
);
alter table public.opportunities add column packet_hash text generated always as (md5(packet::text)) stored;
alter table public.opportunity_source_versions enable row level security;
alter table public.quality_labels enable row level security;
revoke all on public.opportunity_source_versions,public.quality_labels from anon,authenticated;
grant select on public.opportunity_source_versions,public.quality_labels to authenticated;
grant all on public.opportunity_source_versions,public.quality_labels to service_role;
create policy source_versions_member_read on public.opportunity_source_versions for select to authenticated using(organization_id in(select organization_id from public.memberships where user_id=(select auth.uid())));
create policy quality_member_read on public.quality_labels for select to authenticated using(organization_id in(select organization_id from public.memberships where user_id=(select auth.uid())));
create function private.label_opportunity(p_id uuid,p_revision integer,p_hash text,p_request uuid,p_labels jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare o public.opportunities; existing public.quality_labels; result uuid;
begin
 if auth.uid() is null then raise exception 'authentication_required';end if;
 select * into o from public.opportunities where id=p_id for update;
 if not found or not exists(select 1 from public.memberships where organization_id=o.organization_id and user_id=auth.uid()) then raise exception 'not_found';end if;
 select * into existing from public.quality_labels where organization_id=o.organization_id and request_key=p_request;
 if found then
  if existing.opportunity_id<>o.id or existing.reviewer_id<>auth.uid() or existing.revision<>p_revision or existing.packet_hash<>p_hash or existing.labels is distinct from p_labels then raise exception 'request_key_conflict';end if;
  return existing.id;
 end if;
 if o.revision<>p_revision or o.packet_hash is distinct from p_hash then raise exception 'stale_version';end if;
 if jsonb_typeof(p_labels) is distinct from 'object' or jsonb_typeof(p_labels->'note') is distinct from 'string' or length(trim(p_labels->>'note')) not between 1 and 2000
 or coalesce(p_labels->>'serviceRelevance','') not in ('useful','unclear','irrelevant')
 or coalesce(p_labels->>'factualSupport','') not in ('supported','needs_correction','unknown')
 or coalesce(p_labels->>'offerUsefulness','') not in ('useful','needs_work','unknown')
 or coalesce(p_labels->>'buyerFit','') not in ('appropriate','wrong_buyer','unknown')
 or coalesce(p_labels->>'editsRequired','') not in ('none','minor','major','no_draft')
 or jsonb_typeof(p_labels->'reviewSeconds') is distinct from 'number'
 or coalesce(p_labels->>'reviewSeconds','') !~ '^[0-9]{1,5}$'
 or (p_labels->>'reviewSeconds')::integer>86400 then raise exception 'invalid_quality_labels';end if;
 insert into public.quality_labels(organization_id,opportunity_id,revision,packet_hash,reviewer_id,request_key,labels,snapshot)
 values(o.organization_id,o.id,o.revision,o.packet_hash,auth.uid(),p_request,p_labels,o.packet) returning id into result;
 return result;
end $$;
create function public.label_opportunity(p_id uuid,p_revision integer,p_hash text,p_request uuid,p_labels jsonb) returns uuid language sql security invoker set search_path='' as $$select private.label_opportunity(p_id,p_revision,p_hash,p_request,p_labels)$$;
revoke all on function private.label_opportunity(uuid,integer,text,uuid,jsonb),public.label_opportunity(uuid,integer,text,uuid,jsonb) from public,anon;
grant execute on function private.label_opportunity(uuid,integer,text,uuid,jsonb),public.label_opportunity(uuid,integer,text,uuid,jsonb) to authenticated;
-- No live access is inferred from the existence of a public adapter.
insert into public.provider_limits(provider,limit_usd) values('contracts_finder',0) on conflict do nothing;

create or replace function public.ingest_discovery(p_job uuid,p_token uuid,p_candidates jsonb,p_report jsonb) returns boolean language plpgsql security invoker set search_path='' as $$
<<ingest_discovery>>
declare j public.jobs; c jsonb; oid uuid; packet jsonb; prior public.discovery_observations;
 identity_key text; content_key text; new_count integer:=0; duplicates integer:=0; changed_count integer:=0; capped integer:=0; total integer; researched integer; scheduled integer:=0; research_limit integer; current_row public.opportunities; next_revision integer;
begin
 select * into j from public.jobs where id=p_job for update;
 if not found then return false; end if;
 if j.status='done' and j.attempt_token=p_token then return true; end if;
 if j.stage<>'S02' or j.status<>'running' or j.attempt_token is distinct from p_token or j.lease_until<=now() then return false; end if;
 perform 1 from public.campaigns where id=j.campaign_id and not paused for update;
 if not found then return false; end if;
 if jsonb_typeof(p_candidates) is distinct from 'array' or jsonb_array_length(p_candidates)>4 then raise exception 'candidate_limit'; end if;
 research_limit:=coalesce((p_report->>'maxResearch')::integer,1);
 if research_limit not between 0 and 1 then raise exception 'research_limit'; end if;
 select count(*) into total from public.opportunities where campaign_id=j.campaign_id;
 select count(distinct opportunity_id) into researched from public.jobs where campaign_id=j.campaign_id and stage='S04';
 for c in select * from jsonb_array_elements(p_candidates) loop
  identity_key:=coalesce(c->'procurementNotice'->>'noticeId',c->'providerRecord'->>'id',c->>'eventKey');
  content_key:=coalesce(c->'procurementNotice'->>'snapshotHash',md5((c-'discoveredAt'-'providerRecord'||case when c?'providerRecord' then jsonb_build_object('providerRecord',(c->'providerRecord')-'observedAt') else '{}'::jsonb end)::text));
  select * into prior from public.discovery_observations where organization_id=j.organization_id and campaign_id=j.campaign_id and source=c->>'source' and external_id=identity_key order by observed_at desc,id desc limit 1;
  oid:=prior.opportunity_id;
  if oid is null then select id into oid from public.opportunities where organization_id=j.organization_id and campaign_id=j.campaign_id and event_key=c->>'eventKey'; end if;
  if oid is null then
   if total>=40 then capped:=capped+1;continue;end if;
   packet:=jsonb_build_object('candidate',c,'evidence','[]'::jsonb,'state','discovered','mode',p_report->>'mode','notes','[]'::jsonb);
   insert into public.opportunities(organization_id,campaign_id,event_key,packet) values(j.organization_id,j.campaign_id,c->>'eventKey',packet) returning id into oid;
   total:=total+1;new_count:=new_count+1;
   if scheduled<research_limit and researched<10 then
    insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
    values(j.organization_id,j.campaign_id,oid,oid::text||':S04:1','S04',md5(packet::text),1,'1','8',packet);
    scheduled:=scheduled+1;researched:=researched+1;
   end if;
  else
   duplicates:=duplicates+1;
   select * into current_row from public.opportunities where id=oid for update;
   if c?'procurementNotice' and prior.id is not null and (current_row.packet#>>'{candidate,procurementNotice,snapshotHash}') is distinct from content_key
    and coalesce(c#>>'{procurementNotice,postedAt}','')>=coalesce(current_row.packet#>>'{candidate,procurementNotice,postedAt}','') then
    insert into public.opportunity_source_versions(organization_id,opportunity_id,revision,snapshot,reason)
    values(j.organization_id,oid,current_row.revision,current_row.packet,'procurement_notice_changed');
    next_revision:=current_row.revision+1;
    packet:=jsonb_build_object('candidate',c,'evidence','[]'::jsonb,'state','procurement_changed','mode',p_report->>'mode','notes',jsonb_build_array('Published notice changed. Previous evidence, draft and reviews are preserved in version history; fresh review is required.'));
    update public.opportunities set packet=ingest_discovery.packet,revision=next_revision,state='procurement_changed',updated_at=now() where id=oid;
    update public.jobs set status='blocked',error='superseded_by_notice',lease_until=null where opportunity_id=oid and status in ('queued','running');
    if scheduled<research_limit then
     insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
     values(j.organization_id,j.campaign_id,oid,oid::text||':notice:'||next_revision,'S04',md5(packet::text),next_revision,'1','10',packet);
     scheduled:=scheduled+1;
    end if;
   end if;
  end if;
  insert into public.discovery_observations(organization_id,campaign_id,opportunity_id,job_id,source,external_id,event_key,content_hash,candidate,changed)
  values(j.organization_id,j.campaign_id,oid,j.id,c->>'source',identity_key,c->>'eventKey',content_key,c,prior.id is not null and prior.content_hash<>content_key);
  if prior.id is not null and prior.content_hash<>content_key then changed_count:=changed_count+1;end if;
 end loop;
 if not public.complete_job(p_job,p_token,p_report||jsonb_build_object('newOpportunities',new_count,'duplicateObservations',duplicates,'changedProviderRecords',changed_count,'candidateCapDeferred',capped,'researchQueued',scheduled),null) then raise exception 'ownership_lost';end if;
 return true;
end $$;

create or replace function public.queue_discovery(p_campaign uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare c public.campaigns; pending public.jobs; jid uuid; payload jsonb; seen jsonb;
begin
 select * into c from public.campaigns where id=p_campaign for update;
 if not found then raise exception 'campaign_missing'; end if;
 if c.paused then raise exception 'campaign_paused'; end if;
 if jsonb_typeof(c.profile->'groups') is distinct from 'array' or jsonb_array_length(c.profile->'groups') not between 1 and 16 then raise exception 'search_groups_required'; end if;
 select * into pending from public.jobs where campaign_id=c.id and stage='S02' and status in('queued','running') order by created_at limit 1;
 if found then return jsonb_build_object('jobId',pending.id,'created',false); end if;
 select coalesce(jsonb_agg(x.id),'[]'::jsonb) into seen from
 (select distinct v.external_id::bigint id from (
  select external_id from public.discovery_observations where organization_id=c.organization_id and source='theirstack'
  union all
  select record->>'id' from public.provider_operations o cross join lateral jsonb_array_elements(case when jsonb_typeof(o.response->'body'->'data')='array' then o.response->'body'->'data' else '[]'::jsonb end) record
  where o.organization_id=c.organization_id and o.provider='theirstack' and o.state='succeeded'
 ) v where v.external_id~'^[0-9]{1,16}$' order by id desc limit 500) x;
 payload:=c.profile||jsonb_build_object('asOf',now(),'groupIndex',c.discovery_cursor,'seenTheirStackIds',seen);
 insert into public.jobs(organization_id,campaign_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload)
 values(c.organization_id,c.id,c.id::text||':discovery:'||c.version||':'||c.discovery_cursor,'S02',md5(payload::text),c.version,'1','8',payload) returning id into jid;
 update public.campaigns set discovery_cursor=discovery_cursor+1 where id=c.id;
 return jsonb_build_object('jobId',jid,'created',true,'groupIndex',c.discovery_cursor);
end $$;
revoke execute on function public.queue_discovery(uuid) from public,anon,authenticated;
grant execute on function public.queue_discovery(uuid) to service_role;
