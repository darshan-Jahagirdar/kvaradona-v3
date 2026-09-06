-- Private evidence only; the worker uploads and reviewers read within their organization.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('website-captures','website-captures',false,2000000,array['image/png']);
create policy website_capture_member_read on storage.objects for select to authenticated
using(bucket_id='website-captures' and split_part(name,'/',1) in
 (select m.organization_id::text from public.memberships m where m.user_id=(select auth.uid())));
