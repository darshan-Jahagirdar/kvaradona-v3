import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {testDatabase,seed,org,otherOrg,user} from './database';
it('isolates private screenshots, disallows browser writes, and can revoke access without deleting evidence',async()=>{
 const db=await testDatabase();try{
  await seed(db);await db.exec(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text);alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated,service_role;grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;`);
  const sql=await readFile('supabase/migrations/20260906144205_website_capture_storage.sql','utf8');await db.exec(sql);
  await db.query('insert into storage.objects values($1,$2),($1,$3)',['website-captures',`${org}/capture/mobile.png`,`${otherOrg}/capture/mobile.png`]);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${user}';`);
  expect((await db.query('select * from storage.objects')).rows).toHaveLength(1);
  await expect(db.exec(`insert into storage.objects values('website-captures','${org}/overwrite.png')`)).rejects.toThrow('row-level security');
  await db.exec('reset role;set role anon;');expect((await db.query('select * from storage.objects')).rows).toHaveLength(0);
  await db.exec('reset role;drop policy website_capture_member_read on storage.objects;set role authenticated;');expect((await db.query('select * from storage.objects')).rows).toHaveLength(0);
  await db.exec('reset role;');expect((await db.query('select * from storage.objects')).rows).toHaveLength(2);
  await db.exec(sql.slice(sql.indexOf('create policy')));await db.exec(`set role authenticated;`);expect((await db.query('select * from storage.objects')).rows).toHaveLength(1);
 }finally{await db.close();}
});
