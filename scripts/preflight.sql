select jsonb_build_object(
 'database',current_database(),'engine',version(),
 'application_relations',(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','v','m')),
 'application_functions',(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')),
 'auth_users',(select count(*) from auth.users),'stored_objects',(select count(*) from storage.objects),
 'database_bytes',pg_database_size(current_database()),
 'extensions',(select jsonb_agg(jsonb_build_object('name',extname,'version',extversion)) from pg_extension),
 'schemas',(select jsonb_agg(jsonb_build_object('name',nspname,'acl',nspacl::text)) from pg_namespace where nspname in ('public','private'))
) as baseline;
