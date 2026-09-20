/** Prepares the selected-company-runs migration for application, following the same pattern as
 *  scripts/prepare-migration.ts: one atomic transaction that records its own migration history and
 *  refuses to run twice or against an unexpected schema.
 *
 *  Output: .local/apply-selected-company-runs.sql  (excluded from publication)
 *  Apply it as one statement in the Supabase SQL editor, or through any authorized psql session.
 *  Recovery: supabase/recovery/022_selected_company_runs_rollback.sql
 */
import {readFile,writeFile,mkdir} from 'node:fs/promises';

const version='20260920090000',name='selected_company_runs';
const sql=await readFile(`supabase/migrations/${version}_${name}.sql`,'utf8');
if(sql.includes('$kvara_source$'))throw new Error('delimiter_collision');

const apply=`-- Kvaradona V3 · selected-company runs · migration ${version}
-- Atomic: the whole transaction applies or nothing does.
-- Preconditions are checked before any change; each function rewrite inside the migration also
-- aborts if the live definition is not what it expects.
begin;

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations(version text not null primary key, statements text[], name text);

do $precondition$ begin
 if exists(select 1 from supabase_migrations.schema_migrations where version='${version}')
  then raise exception 'migration_already_applied'; end if;
 -- The child-job INSERT lives in this function after the KVD101 rename; the migration patches it.
 if to_regprocedure('public.complete_job_pre_kvd101(uuid,uuid,jsonb,jsonb)') is null
  then raise exception 'prerequisite_missing: complete_job_pre_kvd101 (apply 20260917172819 first)'; end if;
 if to_regprocedure('public.reserve_operation(uuid,uuid,text,text,text,numeric,integer)') is null
  then raise exception 'prerequisite_missing: reserve_operation'; end if;
 if to_regprocedure('public.dispatch_operation(uuid,uuid,uuid)') is null
  then raise exception 'prerequisite_missing: dispatch_operation'; end if;
 if not exists(select 1 from pg_tables where schemaname='public' and tablename='workflow_runs')
  then raise exception 'prerequisite_missing: workflow_runs'; end if;
 -- Nothing may be mid-flight while authorization functions are replaced.
 if exists(select 1 from public.jobs where status in ('queued','running'))
  then raise exception 'queued_or_running_jobs_present: stop the worker and let the queue drain first'; end if;
end $precondition$;

${sql}

insert into supabase_migrations.schema_migrations(version,name,statements)
values('${version}','${name}',array[$kvara_source$${sql}$kvara_source$]);

commit;

-- Verification: three new functions, the membership table, jobs.run_id and the recorded history.
select
 (select count(*) from information_schema.routines
   where routine_schema in ('public','private')
   and routine_name in ('start_selected_workflow','selectable_companies','selected_run_status','selected_entry_stage','record_run_result')) as new_functions,
 (select count(*) from pg_tables where schemaname='public' and tablename='workflow_run_members') as membership_table,
 (select count(*) from information_schema.columns where table_name='jobs' and column_name='run_id') as jobs_run_id,
 (select count(*) from information_schema.columns where table_name='workflow_runs' and column_name in ('mode','status','expires_at')) as run_columns,
 (select count(*) from supabase_migrations.schema_migrations where version='${version}') as recorded;
`;

await mkdir('.local',{recursive:true});
await writeFile('.local/apply-selected-company-runs.sql',apply);
console.log(`Prepared .local/apply-selected-company-runs.sql (${apply.length} characters).`);
// 8 = three functions with private+public wrappers, plus two private-only helpers.
console.log('Expected verification row: new_functions=8, membership_table=1, jobs_run_id=1, run_columns=3, recorded=1.');
