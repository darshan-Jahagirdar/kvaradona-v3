-- User-authorized general workflow correction; no launch, balance refresh, or sending.
-- New human-initiated runs get a campaign-scoped contact window, independent of slow research.
do $fix$ declare definition text; before text; after text; begin
 definition:=pg_get_functiondef('public.reserve_operation(uuid,uuid,text,text,text,numeric,integer)'::regprocedure);
 before:='scoped_apollo:=p_provider=''apollo'' and j.stage=''S10'' and coalesce((l.evidence::jsonb#>''{contactExecutionGrant,opportunityIds}'') ? j.opportunity_id::text,false) and coalesce((l.evidence::jsonb#>>''{contactExecutionGrant,expiresAt}'')::timestamptz>now(),false);';
 after:='scoped_apollo:=p_provider=''apollo'' and j.stage=''S10'' and ((coalesce((l.evidence::jsonb#>''{contactExecutionGrant,opportunityIds}'') ? j.opportunity_id::text,false) and coalesce((l.evidence::jsonb#>>''{contactExecutionGrant,expiresAt}'')::timestamptz>now(),false)) or exists(select 1 from public.campaigns c join public.workflow_runs w on w.campaign_id=c.id where c.id=j.campaign_id and c.organization_id=j.organization_id and (c.profile->>''contactExecutionExpiresAt'')::timestamptz>now()));';
 if position(before in definition)=0 then raise exception 'unexpected_contact_definition';end if;
 execute replace(definition,before,after);
 definition:=pg_get_functiondef('private.start_workflow(uuid,uuid)'::regprocedure);
 if position('if cap>3 or committed+0.025>cap then' in definition)=0 then raise exception 'unexpected_launch_definition';end if;
 definition:=replace(definition,'if cap>3 or committed+0.025>cap then','if (select dollar_limits_enabled from public.budget where id=1) and (cap>3 or committed+0.025>cap) then');
 before:='insert into public.campaigns(organization_id,name,version,profile,paused)';
 if position(before in definition)=0 then raise exception 'unexpected_campaign_definition';end if;
 definition:=replace(definition,before,'run_profile:=jsonb_set(run_profile,''{contactExecutionExpiresAt}'',to_jsonb(now()+interval ''24 hours'')); '||before);
 execute definition;
end $fix$;
