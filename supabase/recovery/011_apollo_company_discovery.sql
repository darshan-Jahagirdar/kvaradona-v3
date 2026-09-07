-- Disable new launches and queued Apollo runs; retain records, evidence and all charges.
revoke execute on function public.start_workflow(uuid,uuid) from authenticated;
update public.campaigns set paused=true where profile#>>'{groups,0,source}'='apollo';
update public.jobs set status='blocked',error='apollo_revision_recovery',lease_until=null where status='queued' and campaign_id in(select id from public.campaigns where profile#>>'{groups,0,source}'='apollo');
