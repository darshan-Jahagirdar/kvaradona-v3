-- Settings recovery only: preserve every job, source, response and reservation.
-- Never lower below already spent/held amounts. Quiesce the worker before using this.
begin;
update public.budget set live_enabled=false where id=1;
do $$ begin
 if (select coalesce(sum(coalesce(actual_usd,reserved_usd)),0) from public.provider_operations)>1
 then raise exception 'cannot_restore_one_dollar_cap_below_committed_usage'; end if;
end $$;
update public.budget set limit_usd=1 where id=1;
alter table public.budget drop constraint budget_limit_usd_check;
alter table public.budget add constraint budget_limit_usd_check check(limit_usd between 0 and 1);
update public.provider_limits set limit_usd=case provider when 'openai' then 0.9 else 0.1 end,probe_enabled=false where provider in ('openai','brave');
drop function public.replace_ambiguous_draft(uuid,text);
commit;
