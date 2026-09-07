-- Retain the approved ICP and records while disabling launch during recovery.
revoke execute on function public.start_workflow(uuid,uuid) from authenticated;
-- Restore from the private preflight only after a verified intent integration is available; do not reinstate the rejected broad search.
