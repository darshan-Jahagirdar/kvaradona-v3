import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {PGlite} from '@electric-sql/pglite';
import {migratedDatabase,asUser,localStore,org,user,campaign} from './database';
import {Job} from '../src/contracts/pipeline';
import {Packet} from '../src/contracts/pipeline';
import {OperationGateway} from '../src/usage/operations';
import {ApolloContacts,REVEAL_CEILING} from '../src/providers/apollo';
import type {SavedOperation} from '../src/domain/provider-evidence';
import {host,company,ROLE,SERVICE,director,webManager,webManagerPerson} from './fixtures/contact-search';

process.env.APOLLO_API_KEY??='fixture-key-not-used';

const OPP='40000000-0000-4000-8000-0000000000d1',RUN='70000000-0000-4000-8000-0000000000d2';
/** The primary search finds a reachable director whose reveal settles WITHOUT a usable address. */
const reachableDirector={...director,has_email:true,last_refreshed_at:new Date().toISOString()};
const directorPerson={id:reachableDirector.id,name:'Avery Nagi',title:'Marketing Director',
 email:'avery@v4c.ai',email_status:'catch_all',organization_id:'fixture-org',
 organization:{id:'fixture-org',name:company,primary_domain:host},
 employment_history:[{current:true,end_date:null,organization_id:'fixture-org',title:'Marketing Director'}]};

/** A stub transport that answers the real adapter's real HTTP shape. Everything else — reserving,
 *  dispatching, recording, the free-unit ledger and the run's authority — is the actual gateway
 *  against the actual schema. */
function transport(){
 const requests:string[]=[];
 const fetcher=(async(url:URL|RequestInfo)=>{
  const u=new URL(String(url));
  const titles=u.searchParams.getAll('person_titles[]').join('|');
  const personId=u.searchParams.get('id');
  requests.push(personId?`match:${personId}`:`search:${titles}`);
  const body=personId
   ?{person:personId===reachableDirector.id?directorPerson:personId===webManager.id?webManagerPerson:null}
   :/marketing director|head of marketing/i.test(titles)?{people:[reachableDirector]}
   :/web|demand generation/i.test(titles)?{people:[webManager]}:{people:[]};
  return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json','x-request-id':'fixture'}});
 }) as unknown as typeof fetch;
 return {requests,fetcher};
}

async function seedContactRun(db:PGlite){
 await db.query(`insert into auth.users values($1,'reviewer@example.invalid')`,[user]);
 await db.query(`insert into public.organizations(id,name) values($1,'Fixture company')`,[org]);
 await db.query(`insert into public.memberships values($1,$2,'admin')`,[org,user]);
 await db.query(`insert into public.campaigns(id,organization_id,name,profile,paused) values($1,$2,'Selected cohort','{}',false)`,[campaign,org]);
 await db.query(`insert into public.opportunities(id,organization_id,campaign_id,event_key,packet,state) values($1,$2,$3,'contact','{"mode":"live","state":"contact_pending","evidence":[]}','contact_pending')`,[OPP,org,campaign]);
 await db.query(`insert into public.workflow_runs(id,organization_id,campaign_id,request_key,requested_by,mode,status,expires_at)
  values($1,$2,$3,gen_random_uuid(),$4,'selected','active',now()+interval '4 hours')`,[RUN,org,campaign,user]);
 await db.query(`insert into public.workflow_run_members(run_id,organization_id,opportunity_id,entry_revision,entry_state,queued_stage)
  values($1,$2,$3,1,'contact_pending','S10')`,[RUN,org,OPP]);
 await db.query(`update public.budget set live_enabled=true,dollar_limits_enabled=false where id=1`);
 await db.query(`update public.provider_limits set verified_at=now(),probe_enabled=true where provider in('openai','brave')`);
 await db.query(`update public.provider_limits set verified_at=now(),authenticated=true,usable=true,free_units=75,
  expires_at=now()+interval '1 day' where provider='apollo'`);
}
/** A fresh job, as a worker claims it for this run. */
async function claim(db:PGlite,key:string){
 await db.query(`insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload,run_id)
  values($1,$2,$3,$4,'S10','h',1,'kvd101','kvd101','{}',$5)`,[org,campaign,OPP,key,RUN]);
 return Job.parse(await localStore(db).rpc('claim_job',{p_worker:'fixture-'+key}));
}
async function history(db:PGlite):Promise<SavedOperation[]>{
 const rows=await db.query<any>(`select id,provider,state,response,created_at,opportunity_id,operation_key,request_hash,actual_usd
  from public.provider_operations where opportunity_id=$1 order by id`,[OPP]);
 return rows.rows.map(r=>({...r,created_at:new Date(r.created_at).toISOString()}));
}
const allowance=()=>({remaining:75,expiresAt:new Date(Date.now()+3600000).toISOString(),
 evidence:'Fixture: user-confirmed free quota only',verifiedFree:true});

it('continues to the next justified search after a settled unusable reveal, and reuses it all on restart',async()=>{
 const db=await migratedDatabase();await seedContactRun(db);
 const store=localStore(db);

 // --- First pass: primary candidate, unusable reveal, alternative search, second candidate. ---
 const job=await claim(db,'contact-1');
 const t=transport();
 const packet=Packet.parse({mode:'fixture',state:'contact_pending',notes:[],evidence:[]});
 const contact=await new ApolloContacts(new OperationGateway(store,job),allowance(),t.fetcher,{operations:await history(db)})
  .resolve(host,ROLE,company,false,packet,SERVICE);

 expect(contact.state).toBe('resolved');
 expect(contact.email).toBe('robin@v4c.ai');
 // The primary search ran, its candidate was revealed and proved unusable, and the NEXT justified
 // search still ran rather than the attempt ending there.
 expect(t.requests[0]).toMatch(/^search:/);
 expect(t.requests[1]).toBe(`match:${reachableDirector.id}`);
 expect(t.requests[2]).toMatch(/^search:/);
 expect(t.requests[3]).toBe(`match:${webManager.id}`);
 expect(t.requests).toHaveLength(4);
 // The person whose reveal settled unusably is preserved, with the reason named.
 expect(contact.candidates?.find(c=>c.providerId===reachableDirector.id)?.limitations).toContain('enrichment_unverified');
 // Both reveals are recorded against the ceiling, and the ledger charged exactly two free units.
 expect(packet.contactPlan?.reveals).toBe(REVEAL_CEILING);
 const settled=await db.query<{n:number;units:number}>(
  `select count(*)::int as n,coalesce(sum(units),0)::int as units from public.provider_operations
   where opportunity_id=$1 and state='succeeded' and actual_usd is not null`,[OPP]);
 expect(settled.rows[0]).toEqual({n:4,units:2});

 // --- Restart: a new job and a new gateway reuse every settled operation. ---
 await db.query(`update public.jobs set status='done' where opportunity_id=$1`,[OPP]);
 const resumeJob=await claim(db,'contact-2');
 const t2=transport();
 const resumePacket=Packet.parse({...packet,state:'contact_pending'});
 const again=await new ApolloContacts(new OperationGateway(store,resumeJob),allowance(),t2.fetcher,{operations:await history(db)})
  .resolve(host,ROLE,company,false,resumePacket,SERVICE);
 expect(again.state).toBe('resolved');
 expect(again.email).toBe('robin@v4c.ai');
 // Nothing was bought again: no request left the adapter and no new operation row exists.
 expect(t2.requests).toHaveLength(0);
 expect((await db.query<{n:number}>(`select count(*)::int as n from public.provider_operations where opportunity_id=$1`,[OPP])).rows[0].n).toBe(4);
 await db.close();
});

it('stops at the reveal ceiling instead of searching on, and never works around an unknown outcome',async()=>{
 const db=await migratedDatabase();await seedContactRun(db);
 const store=localStore(db);
 const job=await claim(db,'ceiling-1');
 const t=transport();
 // Two reveals already recorded for this company, one of them with an unknown cost.
 await db.query(`insert into public.provider_operations(organization_id,campaign_id,job_id,opportunity_id,operation_key,provider,request_hash,state,reserved_usd,actual_usd,units)
  values($1,$2,$3,$4,'old:contact_enrichment','apollo','h1','succeeded',0,0,1),
        ($1,$2,$3,$4,'old:contact_enrichment_2','apollo','h2','succeeded',0,0,1)`,[org,campaign,job.id,OPP]);
 const packet=Packet.parse({mode:'fixture',state:'contact_pending',notes:[],evidence:[]});
 const contact=await new ApolloContacts(new OperationGateway(store,job),allowance(),t.fetcher,{operations:await history(db)})
  .resolve(host,ROLE,company,false,packet,SERVICE);
 expect(contact.state).toBe('contact_pending');
 expect(contact.reason).toContain('authorized reveals');
 // The primary search still ran; no reveal was attempted and no later search was bought after the
 // ceiling was reached.
 expect(t.requests.filter(r=>r.startsWith('match:'))).toHaveLength(0);
 expect(t.requests).toHaveLength(1);

 // An operation whose outcome is unknown stops everything, including a first search.
 const held=await claim(db,'held-1');
 await db.query(`insert into public.provider_operations(organization_id,campaign_id,job_id,opportunity_id,operation_key,provider,request_hash,state,reserved_usd,units)
  values($1,$2,$3,$4,'old:contact_search','apollo','h3','ambiguous',0,0)`,[org,campaign,held.id,OPP]);
 const t2=transport();
 const blocked=await new ApolloContacts(new OperationGateway(store,held),allowance(),t2.fetcher,{operations:await history(db)})
  .resolve(host,ROLE,company,false,Packet.parse({mode:'fixture',state:'contact_pending',notes:[],evidence:[]}),SERVICE);
 expect(blocked.state).toBe('contact_pending');
 expect(blocked.reason).toContain('unresolved operation');
 expect(t2.requests).toHaveLength(0);
 await db.close();
});

it('counts reveals for the company, so a duplicate record does not grant a second authorization',async()=>{
 const db=await migratedDatabase();await seedContactRun(db);
 const {companyContactOperations}=await import('../src/persistence/saved-provider-operations');
 const duplicate='40000000-0000-4000-8000-0000000000d3';
 // A second opportunity record for the SAME company, with its own recorded reveal.
 await db.query(`insert into public.opportunities(id,organization_id,campaign_id,event_key,packet,state)
  values($1,$2,$3,'duplicate',$4,'contact_pending')`,[duplicate,org,campaign,
  JSON.stringify({mode:'live',state:'contact_pending',evidence:[],research:{company,accountHost:host}})]);
 const job=await claim(db,'dup-1');
 await db.query(`insert into public.provider_operations(organization_id,campaign_id,job_id,opportunity_id,operation_key,provider,request_hash,state,reserved_usd,actual_usd,units)
  values($1,$2,$3,$4,'dup:contact_enrichment','apollo','h9','succeeded',0,0,1)`,[org,campaign,job.id,duplicate]);

 const client={from:(table:string)=>({
  select:(cols:string)=>{
   const state={table,cols,filters:[] as [string,string][],or:'',after:null as string|null,limit:200};
   const api:any={
    eq:(c:string,v:string)=>{state.filters.push([c,v]);return api;},
    or:(v:string)=>{state.or=v;return api;},
    gt:(_c:string,v:string)=>{state.after=v;return api;},
    order:()=>api,limit:(n:number)=>{state.limit=n;return api;},
    contains:()=>api,
    then:(resolve:(r:{data:any[];error:null})=>void)=>{
     const run=async()=>{
      if(state.table==='opportunities'){
       const rows=await db.query<{id:string}>(`select id from public.opportunities where organization_id=$1
        and (packet->'research'->>'accountHost'=$2 or packet->'candidate'->'providerCompany'->>'domain'=$2)`,[org,host]);
       return {data:rows.rows,error:null};
      }
      const rows=await db.query<any>(`select id,provider,state,response,created_at,opportunity_id,operation_key,request_hash,actual_usd
       from public.provider_operations where organization_id=$1 and opportunity_id=$2 and provider='apollo'
       ${state.after?'and id>$3':''} order by id limit ${state.limit}`,
       state.after?[org,state.filters.find(f=>f[0]==='opportunity_id')![1],state.after]
        :[org,state.filters.find(f=>f[0]==='opportunity_id')![1]]);
      return {data:rows.rows.map(r=>({...r,created_at:new Date(r.created_at).toISOString()})),error:null};
     };
     return run().then(resolve);
    }};
   return api;
  }})} as any;

 const scoped=await companyContactOperations(client,org,[host],OPP);
 // The duplicate record's reveal is counted here, so the ceiling is a promise about the company.
 expect(scoped.filter(o=>/:contact_enrichment/.test(o.operation_key??''))).toHaveLength(1);
 expect(scoped.some(o=>o.opportunity_id===duplicate)).toBe(true);
 await db.close();
});
