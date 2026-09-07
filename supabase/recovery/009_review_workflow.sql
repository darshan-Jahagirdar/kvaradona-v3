-- Restore previous execution behavior while preserving all run, campaign and evidence history.
-- In-flight operations retain leases/accounting; stopping the worker precedes recovery.
revoke execute on function private.start_workflow(uuid,uuid),public.start_workflow(uuid,uuid) from authenticated;
update public.campaigns set paused=true where id in(select campaign_id from public.workflow_runs);
update public.jobs set status='blocked',error='workflow_recovery_paused' where status='queued' and campaign_id in(select campaign_id from public.workflow_runs);
