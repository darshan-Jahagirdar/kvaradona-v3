import {readFile,writeFile,mkdir} from 'node:fs/promises';
const version='20260906110533',name='foundation_execution';
const sql=await readFile(`supabase/migrations/${version}_${name}.sql`,'utf8');
const baseline=await readFile('.local/backups/preflight.json','utf8');
if(!baseline.includes('"application_relations": 0')||!baseline.includes('"auth_users": 0'))throw new Error('verified_empty_baseline_required');
if(sql.includes('$kvara_source$'))throw new Error('delimiter_collision');
const apply=`begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations(version text not null primary key, statements text[], name text);
do $$ begin
if exists(select 1 from supabase_migrations.schema_migrations where version='${version}') then raise exception 'migration_already_applied'; end if;
if exists(select 1 from pg_tables where schemaname='public') then raise exception 'initial_migration_requires_empty_public_schema'; end if;
end $$;
${sql}
insert into supabase_migrations.schema_migrations(version,name,statements) values('${version}','${name}',array[$kvara_source$${sql}$kvara_source$]);
commit;
select version,name from supabase_migrations.schema_migrations where version='${version}';`;
await mkdir('.local',{recursive:true});await writeFile('.local/apply-foundation.sql',apply);
console.log('Prepared .local/apply-foundation.sql with atomic migration history.');
