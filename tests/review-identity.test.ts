import {expect,it} from 'vitest';
import {readFile} from 'node:fs/promises';
import {testDatabase,seed,localStore,user,opportunity,migrationPath} from './database';
it('binds review retries to exact input and restores the previous function on an unused migration',async()=>{
 const db=await testDatabase();try{
  const migration=await readFile('supabase/migrations/20260906121200_review_request_identity.sql','utf8');
  await db.exec(migration);
  const foundation=await readFile(migrationPath,'utf8'),start=foundation.indexOf('create function private.review_opportunity'),end=foundation.indexOf('create function public.review_opportunity',start);
  const previous=foundation.slice(start,end).replace('create function private.','create or replace function private.');
  await db.exec(previous+'alter table public.reviews drop column request_payload;');
  await db.exec(migration);await seed(db);const store=localStore(db);
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${user}',false);`);
  const args={p_id:opportunity,p_revision:1,p_request:'50000000-0000-4000-8000-000000000088',p_action:'defer',p_note:'Wait for supporting evidence',p_draft:null};
  await store.rpc('review_opportunity',args);await store.rpc('review_opportunity',args);
  await expect(store.rpc('review_opportunity',{...args,p_action:'reject'})).rejects.toThrow('request_key_conflict');
  await expect(store.rpc('review_opportunity',{...args,p_note:'Different decision'})).rejects.toThrow('request_key_conflict');
  expect((await db.query('select state,revision from public.opportunities')).rows).toEqual([{state:'defer',revision:2}]);
 }finally{await db.close();}
});
