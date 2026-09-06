import {expect,it} from 'vitest';
import {readFile} from 'node:fs/promises';
import {testDatabase,migrationPath} from './database';
it('restores the verified empty baseline and reapplies the versioned schema',async()=>{
 const db=await testDatabase();try{
 await db.exec(await readFile('supabase/recovery/001_empty_only.sql','utf8'));
 expect((await db.query(`select tablename from pg_tables where schemaname='public'`)).rows).toHaveLength(0);
 await db.exec(await readFile(migrationPath,'utf8'));
 expect((await db.query('select limit_usd::text from public.budget')).rows).toEqual([{limit_usd:'1.00000000'}]);
 }finally{await db.close();}
});
