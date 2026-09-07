-- Pause Explorium without deleting trial usage, source history or reviewed drafts.
begin;
update public.provider_limits set probe_enabled=false,usable=false,expires_at=now() where provider='explorium';
update public.jobs set status='blocked',error='explorium_recovery_pause'
where status='queued' and stage='S02' and payload#>>'{groups,0,source}'='explorium';
commit;
