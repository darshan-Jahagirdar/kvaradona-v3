import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {ApolloContacts,contactSearchPlan,candidateLimitations,intentBuyerTitle,roleScore} from '../src/providers/apollo';
import {Packet} from '../src/contracts/pipeline';

/** The saved v4c.ai search from run 8f7242ac. Both returned people report has_email:false, and the
 *  Marketing Director was previously removed by the discovery-only intentBuyerTitle filter. */
const AUDIT='/Users/darshan_j/Kvaradona V3/.local/selected-run-review-20260921/audit.json';
async function savedSearch(){
 const audit=JSON.parse(await readFile(AUDIT,'utf8'));
 const op=audit.operations.find((o:any)=>String(o.operation_key).endsWith(':contact_search'));
 return op.response;
}
const ROLE='Head of Marketing, Demand Generation, or Website/Digital Experience';
const SERVICE='Website CRO and conversion-path QA';

/** Records which operations the adapter asks for and answers with a canned envelope, so the test
 *  exercises the adapter's decisions rather than the HTTP layer. */
function gateway(people:Record<string,unknown[]>={}){
 const calls:string[]=[];
 return {calls,ops:{async run(key:string,_p:string,_r:unknown,_m:string,_u:number,schema:z.ZodType<any>){
  calls.push(key);
  return schema.parse({httpStatus:200,body:{people:people[key]??[]}});}}};
}

it('keeps the saved Marketing Director instead of filtering them out as a discovery non-buyer',async()=>{
 const saved=await savedSearch();
 // The old discovery filter is what removed them.
 expect(intentBuyerTitle('Marketing Director')).toBe(false);
 expect(roleScore('Marketing Director',ROLE)).toBeGreaterThanOrEqual(20);

 const g=gateway();
 const packet=Packet.parse({mode:'fixture',state:'contact_pending',notes:[],evidence:[]});
 const contact=await new ApolloContacts(g.ops as any,null,fetch,saved,{operations:[]})
  .resolve('v4c.ai',ROLE,'v4c.ai',false,packet,SERVICE);

 const director=contact.candidates?.find(c=>/Marketing Director/i.test(c.role));
 expect(director).toBeDefined();
 expect(director!.emailAvailable).toBe(false);
 // Preserved, explained, and NOT promoted to a contact.
 expect(director!.limitations).toContain('no_provider_email');
 expect(contact.state).toBe('contact_pending');
 expect(contact.email).toBeNull();
 expect(contact.name).toBeNull();
 expect(contact.reason).toContain('none is reachable');
 expect(contact.reason).toContain('no work email');
});

it('preserves the junior candidate too, with its own distinct limitation',async()=>{
 const saved=await savedSearch();
 const g=gateway();
 const packet=Packet.parse({mode:'fixture',state:'contact_pending',notes:[],evidence:[]});
 const contact=await new ApolloContacts(g.ops as any,null,fetch,saved,{operations:[]})
  .resolve('v4c.ai',ROLE,'v4c.ai',false,packet,SERVICE);
 const specialist=contact.candidates?.find(c=>/Specialist/i.test(c.role));
 expect(specialist).toBeDefined();
 expect(specialist!.limitations).toContain('below_buyer_seniority');
 expect(specialist!.limitations).toContain('no_provider_email');
 // Both saved people survive filtering; neither becomes a resolved contact.
 expect(contact.candidates).toHaveLength(2);
});

it('runs bounded, meaningfully different alternatives and persists the plan',async()=>{
 const saved=await savedSearch();
 const g=gateway();
 const packet=Packet.parse({mode:'fixture',state:'contact_pending',notes:[],evidence:[]});
 await new ApolloContacts(g.ops as any,null,fetch,saved,{operations:[]})
  .resolve('v4c.ai',ROLE,'v4c.ai',false,packet,SERVICE);
 // Initial reuses the saved response; at most two further searches, under stable distinct keys.
 expect(g.calls).toEqual(['contact_search_alt_1','contact_search_alt_2']);
 expect(packet.contactPlan?.attempts).toHaveLength(3);
 expect(packet.contactPlan!.attempts.map(a=>a.key)).toEqual(['contact_search','contact_search_alt_1','contact_search_alt_2']);
 expect(packet.contactPlan!.attempts[0].outcome).toBe('no_reachable_candidate');
 // Growth and Digital were already searched, so an alternative must not repeat them.
 const alt=packet.contactPlan!.attempts.slice(1).flatMap(a=>a.titles.map(t=>t.toLowerCase()));
 expect(alt).not.toContain('growth');
 expect(alt).not.toContain('digital');
 expect(alt).not.toContain('marketing');
});

it('never redispatches an unresolved earlier search after a resume',async()=>{
 const saved=await savedSearch();
 const g=gateway();
 const packet=Packet.parse({mode:'fixture',state:'contact_pending',notes:[],evidence:[]});
 const contact=await new ApolloContacts(g.ops as any,null,fetch,saved,
  {operations:[{operation_key:'x:contact_search_alt_1',state:'dispatched',actual_usd:null,created_at:new Date().toISOString(),response:null} as any]})
  .resolve('v4c.ai',ROLE,'v4c.ai',false,packet,SERVICE);
 expect(contact.reason).toContain('unresolved operation');
 expect(g.calls).not.toContain('contact_search_alt_1');
 expect(contact.state).toBe('contact_pending');
});

it('reuses a settled alternative on resume rather than buying it again',async()=>{
 const saved=await savedSearch();
 const g=gateway();
 const packet=Packet.parse({mode:'fixture',state:'contact_pending',notes:[],evidence:[]});
 const settled={operation_key:'x:contact_search_alt_1',state:'succeeded',actual_usd:'0',created_at:new Date().toISOString(),
  response:{httpStatus:200,body:{people:[]}}} as any;
 await new ApolloContacts(g.ops as any,null,fetch,saved,{operations:[settled]})
  .resolve('v4c.ai',ROLE,'v4c.ai',false,packet,SERVICE);
 expect(g.calls).not.toContain('contact_search_alt_1');
 expect(g.calls).toContain('contact_search_alt_2');
});

it('still applies the discovery buyer constraint when the run is not a selected one',()=>{
 // The flag itself is unchanged; only the worker's reason for setting it moved off provenance.
 expect(intentBuyerTitle('Chief Marketing Officer')).toBe(true);
 expect(intentBuyerTitle('Marketing Director')).toBe(false);
});

it('plans at most three searches and always leads with the researched roles',()=>{
 const plan=contactSearchPlan(ROLE,SERVICE);
 expect(plan.length).toBeLessThanOrEqual(3);
 expect(plan[0].titles[0]).toContain('Head of Marketing');
 expect(new Set(plan.flatMap(p=>p.titles.map(t=>t.toLowerCase()))).size)
  .toBe(plan.flatMap(p=>p.titles).length);
});

it('names each unmet requirement separately',()=>{
 const stale={title:'Marketing Director',has_email:true,last_refreshed_at:'2020-01-01T00:00:00Z',organization:{name:'v4c.ai'}};
 expect(candidateLimitations(stale,ROLE,'v4c.ai')).toEqual(['provider_data_stale']);
 const other={title:'Marketing Director',has_email:true,last_refreshed_at:new Date().toISOString(),organization:{name:'Someone Else'}};
 expect(candidateLimitations(other,ROLE,'v4c.ai')).toEqual(['employer_unconfirmed']);
 const good={title:'Marketing Director',has_email:true,last_refreshed_at:new Date().toISOString(),organization:{name:'v4c.ai'}};
 expect(candidateLimitations(good,ROLE,'v4c.ai')).toEqual([]);
});
