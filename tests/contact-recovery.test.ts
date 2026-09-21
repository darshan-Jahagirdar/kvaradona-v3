import {it,expect} from 'vitest';
import {z} from 'zod';
import {ApolloContacts,contactSearchPlan,candidateLimitations,intentBuyerTitle,roleScore,roleScoreFor,
 searchParams,enrichmentParams,REVEAL_CEILING} from '../src/providers/apollo';
import {Packet} from '../src/contracts/pipeline';
import {hash} from '../src/domain/policy';
import type {SavedOperation} from '../src/domain/provider-evidence';
import {host,company,ROLE,SERVICE,savedSearch,director,specialist,webManager,webManagerPerson,
 contentLead,contentLeadPerson} from './fixtures/contact-search';

/** Records which operations the adapter asks for and answers with a canned envelope, so the test
 *  exercises the adapter's decisions rather than the HTTP layer. */
function gateway(bodies:Record<string,unknown>={}){
 const calls:string[]=[];
 return {calls,ops:{async run(key:string,_p:string,_r:unknown,_m:string,_u:number,schema:z.ZodType<any>){
  calls.push(key);
  if(!(key in bodies))return schema.parse({httpStatus:200,body:{people:[]}});
  return schema.parse({httpStatus:200,body:bodies[key]});}}};
}
const packet=()=>Packet.parse({mode:'fixture',state:'contact_pending',notes:[],evidence:[]});
const settled=(over:Partial<SavedOperation>):SavedOperation=>({id:'op',provider:'apollo',state:'succeeded',
 actual_usd:'0',created_at:new Date().toISOString(),response:null,...over});
/** The exact canonical request a search step is bound to. */
const searchOp=(titles:string[],response:unknown,over:Partial<SavedOperation>={})=>settled(
 {request_hash:hash({endpoint:'mixed_people/api_search',params:searchParams(host,titles)}),
  operation_key:'job:contact_search',response,...over});
const revealOp=(personId:string,response:unknown,over:Partial<SavedOperation>={})=>settled(
 {request_hash:hash({endpoint:'people/match',params:enrichmentParams(host,personId)}),
  operation_key:'job:contact_enrichment',response,...over});
const primaryTitles=()=>contactSearchPlan(ROLE,SERVICE)[0].titles;
const altTitles=(i:number)=>contactSearchPlan(ROLE,SERVICE)[i].titles;

it('keeps the saved Marketing Director instead of filtering them out as a discovery non-buyer',async()=>{
 // The old discovery filter is what removed them.
 expect(intentBuyerTitle('Marketing Director')).toBe(false);
 expect(roleScore('Marketing Director',ROLE)).toBeGreaterThanOrEqual(20);

 const g=gateway();const p=packet();
 const contact=await new ApolloContacts(g.ops as any,null,fetch,{operations:[searchOp(primaryTitles(),savedSearch)]})
  .resolve(host,ROLE,company,false,p,SERVICE);

 const found=contact.candidates?.find(c=>/Marketing Director/i.test(c.role));
 expect(found).toBeDefined();
 expect(found!.emailAvailable).toBe(false);
 // Preserved, explained, and NOT promoted to a contact.
 expect(found!.limitations).toContain('no_provider_email');
 expect(contact.state).toBe('contact_pending');
 expect(contact.email).toBeNull();
 expect(contact.name).toBeNull();
 expect(contact.reason).toContain('none is reachable');
 expect(contact.reason).toContain('no work email');
 // A found candidate is not a resolved contact, and the plan records that distinction.
 expect(p.contactPlan?.resolvedContact).toBe(false);
 expect(p.contactPlan?.attempts[0].outcome).toBe('no_reachable_candidate');
});

it('preserves the junior candidate too, with its own distinct limitation',async()=>{
 const g=gateway();
 const contact=await new ApolloContacts(g.ops as any,null,fetch,{operations:[searchOp(primaryTitles(),savedSearch)]})
  .resolve(host,ROLE,company,false,packet(),SERVICE);
 const junior=contact.candidates?.find(c=>/Specialist/i.test(c.role));
 expect(junior).toBeDefined();
 expect(junior!.limitations).toContain('below_buyer_seniority');
 expect(junior!.limitations).toContain('no_provider_email');
 expect(contact.candidates).toHaveLength(2);
});

it('runs bounded, meaningfully different alternatives and persists the plan with its criteria',async()=>{
 const g=gateway();const p=packet();
 await new ApolloContacts(g.ops as any,null,fetch,{operations:[searchOp(primaryTitles(),savedSearch)]})
  .resolve(host,ROLE,company,false,p,SERVICE);
 // The primary reuses the settled request; at most two further searches, under stable distinct keys.
 expect(g.calls).toEqual(['contact_search_alt_1','contact_search_alt_2']);
 expect(p.contactPlan?.steps?.map(s=>s.key)).toEqual(['contact_search','contact_search_alt_1','contact_search_alt_2']);
 expect(p.contactPlan?.host).toBe(host);
 expect(p.contactPlan?.service).toBe(SERVICE);
 // Growth and Digital were already searched, so an alternative must not repeat them.
 const alt=p.contactPlan!.attempts.slice(1).flatMap(a=>a.titles.map(t=>t.toLowerCase()));
 expect(alt).not.toContain('growth');
 expect(alt).not.toContain('digital');
 expect(alt).not.toContain('marketing');
});

it('accepts an alternative step\'s own relevant title and carries those criteria into enrichment',async()=>{
 // A Web Manager matches nothing in the campaign sentence, so judging the alternative by the first
 // step's wording is exactly what discarded it.
 expect(roleScore('Web Manager',ROLE)).toBe(0);
 expect(roleScoreFor('Web Manager',altTitles(1))).toBeGreaterThanOrEqual(20);

 const g=gateway({contact_search_alt_1:{people:[webManager]},contact_enrichment:{person:webManagerPerson}});
 const p=packet();
 const allowance={remaining:75,expiresAt:new Date(Date.now()+3600000).toISOString(),
  evidence:'Fixture: user-confirmed free quota only',verifiedFree:true};
 const contact=await new ApolloContacts(g.ops as any,allowance,fetch,{operations:[searchOp(primaryTitles(),savedSearch)]})
  .resolve(host,ROLE,company,false,p,SERVICE);

 expect(contact.state).toBe('resolved');
 expect(contact.email).toBe('robin@v4c.ai');
 expect(contact.emailStatus).toBe('provider_verified');
 // The alternative search ran, then exactly one reveal. The third step was never needed.
 expect(g.calls).toEqual(['contact_search_alt_1','contact_enrichment']);
 expect(p.contactPlan?.resolvedContact).toBe(true);
 expect(p.contactPlan?.reveals).toBe(1);
 expect(p.contactPlan?.attempts.find(a=>a.key==='contact_search_alt_1')?.outcome).toBe('candidate_found');
 // The saved people are still preserved next to the resolved one.
 expect(contact.candidates?.map(c=>c.providerId)).toContain(director.id);
 expect(contact.candidates?.map(c=>c.providerId)).toContain(specialist.id);
});

it('reuses only a saved search that answers the SAME request, not the newest one',async()=>{
 // A settled response to different criteria is an answer to a different question.
 const wrongCriteria=searchOp(['revenue operations'],{httpStatus:200,body:{people:[webManager]}},
  {operation_key:'job:contact_search',created_at:new Date().toISOString()});
 const g=gateway();
 const p=packet();
 await new ApolloContacts(g.ops as any,null,fetch,{operations:[wrongCriteria]})
  .resolve(host,ROLE,company,false,p,SERVICE);
 // Nothing was reused: the primary step was bought because no settled response matched its request.
 expect(g.calls[0]).toBe('contact_search');
 expect(p.contactPlan?.attempts[0].returned).toBe(0);
});

it('does not reuse a saved search when the account host changed',async()=>{
 const g=gateway();
 await new ApolloContacts(g.ops as any,null,fetch,{operations:[searchOp(primaryTitles(),savedSearch)]})
  .resolve('other-company.invalid',ROLE,'Other Company',false,packet(),SERVICE);
 expect(g.calls[0]).toBe('contact_search');
});

it('starts a new plan when the researched service changes, and keeps attempts when it does not',async()=>{
 const g=gateway();const p=packet();
 const history={operations:[searchOp(primaryTitles(),savedSearch)]};
 await new ApolloContacts(g.ops as any,null,fetch,history).resolve(host,ROLE,company,false,p,SERVICE);
 const first=p.contactPlan!.attempts.length;
 expect(first).toBeGreaterThan(0);
 await new ApolloContacts(g.ops as any,null,fetch,history).resolve(host,ROLE,company,false,p,SERVICE);
 expect(p.contactPlan?.service).toBe(SERVICE);
 await new ApolloContacts(g.ops as any,null,fetch,history).resolve(host,ROLE,company,false,p,'CRM implementation');
 expect(p.contactPlan?.service).toBe('CRM implementation');
 expect(p.contactPlan?.attempts.every(a=>a.key!=='contact_search_alt_2'||a.titles.length>0)).toBe(true);
});

it('never redispatches while an earlier contact operation has an unknown outcome',async()=>{
 const g=gateway();
 const contact=await new ApolloContacts(g.ops as any,null,fetch,
  {operations:[settled({operation_key:'job:contact_search_alt_1',state:'dispatched',actual_usd:null})]})
  .resolve(host,ROLE,company,false,packet(),SERVICE);
 expect(contact.reason).toContain('unresolved operation');
 expect(g.calls).toHaveLength(0);
 expect(contact.state).toBe('contact_pending');
});

it('treats a plain reservation as not yet dispatched, so it does not hold the account',async()=>{
 const g=gateway();
 await new ApolloContacts(g.ops as any,null,fetch,
  {operations:[settled({operation_key:'job:contact_search',state:'reserved',actual_usd:null})]})
  .resolve(host,ROLE,company,false,packet(),SERVICE);
 expect(g.calls[0]).toBe('contact_search');
});

it('enforces the per-account reveal ceiling across resumes, counting uncertain attempts',async()=>{
 const allowance={remaining:75,expiresAt:new Date(Date.now()+3600000).toISOString(),
  evidence:'Fixture: user-confirmed free quota only',verifiedFree:true};
 // One settled reveal of someone else and one whose outcome is unknown already use the ceiling.
 const history={operations:[
  searchOp(primaryTitles(),savedSearch),
  revealOp('someone-else',{httpStatus:200,body:{person:null}},{operation_key:'job:contact_enrichment'}),
  revealOp('another-person',null,{operation_key:'job:contact_enrichment_2',state:'succeeded',actual_usd:'0'}),
 ]};
 const g=gateway({contact_search_alt_1:{people:[webManager]}});
 const p=packet();
 const contact=await new ApolloContacts(g.ops as any,allowance,fetch,history)
  .resolve(host,ROLE,company,false,p,SERVICE);
 expect(REVEAL_CEILING).toBe(2);
 expect(contact.state).toBe('contact_pending');
 expect(contact.reason).toContain('authorized reveals');
 // The candidate is preserved and no third reveal was bought.
 expect(contact.candidates?.some(c=>c.providerId===webManager.id)).toBe(true);
 expect(g.calls).not.toContain('contact_enrichment_3');
});

it('considers the next suitable candidate when one settled reveal proves unusable',async()=>{
 const allowance={remaining:75,expiresAt:new Date(Date.now()+3600000).toISOString(),
  evidence:'Fixture: user-confirmed free quota only',verifiedFree:true};
 // The Web Manager was already revealed and came back without a usable email: that person is
 // exhausted, the account is not.
 const history={operations:[
  searchOp(primaryTitles(),savedSearch),
  revealOp(webManager.id,{httpStatus:200,body:{person:{...webManagerPerson,email_status:'catch_all'}}}),
 ]};
 const g=gateway({contact_search_alt_1:{people:[webManager,contentLead]},
  contact_enrichment_2:{person:contentLeadPerson}});
 const p=packet();
 const contact=await new ApolloContacts(g.ops as any,allowance,fetch,history)
  .resolve(host,ROLE,company,false,p,SERVICE);
 expect(contact.state).toBe('resolved');
 expect(contact.email).toBe('sam@v4c.ai');
 // The saved reveal was reused rather than repeated, and exactly one new reveal was bought.
 expect(g.calls.filter(k=>k.startsWith('contact_enrichment'))).toEqual(['contact_enrichment_2']);
 expect(contact.candidates?.find(c=>c.providerId===webManager.id)?.limitations).toContain('enrichment_unverified');
});

it('does not work around an uncertain reveal by moving to another person',async()=>{
 const allowance={remaining:75,expiresAt:new Date(Date.now()+3600000).toISOString(),
  evidence:'Fixture: user-confirmed free quota only',verifiedFree:true};
 const history={operations:[
  searchOp(primaryTitles(),savedSearch),
  revealOp(webManager.id,null,{state:'ambiguous',actual_usd:null}),
 ]};
 const g=gateway({contact_search_alt_1:{people:[webManager,contentLead]}});
 const contact=await new ApolloContacts(g.ops as any,allowance,fetch,history)
  .resolve(host,ROLE,company,false,packet(),SERVICE);
 expect(contact.state).toBe('contact_pending');
 expect(contact.reason).toContain('unresolved');
 expect(g.calls.some(k=>k.startsWith('contact_enrichment'))).toBe(false);
});

it('keeps the discovery persona restriction before any reveal, not after one',async()=>{
 const allowance={remaining:75,expiresAt:new Date(Date.now()+3600000).toISOString(),
  evidence:'Fixture: user-confirmed free quota only',verifiedFree:true};
 // Reachable and senior, but outside the discovery buyer policy this run must keep.
 const reachableDirector={...director,has_email:true,last_refreshed_at:new Date().toISOString()};
 const g=gateway({contact_search:{people:[reachableDirector]}});
 const p=packet();
 const contact=await new ApolloContacts(g.ops as any,allowance,fetch,{operations:[]})
  .resolve(host,ROLE,company,true,p,SERVICE);
 // A discovery run searches only its approved buyer titles, and buys no reveal for a person outside
 // that policy. The person is still preserved, with the reason named rather than hidden.
 expect(g.calls).toEqual(['contact_search']);
 expect(contact.state).toBe('contact_pending');
 expect(contact.candidates?.[0]?.limitations).toContain('outside_discovery_persona');
 expect(g.calls.some(k=>k.startsWith('contact_enrichment'))).toBe(false);
 // The same person IS reachable in a selected run, where that discovery policy does not apply.
 const selected=gateway({contact_search:{people:[reachableDirector]},contact_enrichment:{person:{
  ...webManagerPerson,id:reachableDirector.id,name:'Avery Nagi',title:'Marketing Director',email:'avery@v4c.ai',
  employment_history:[{current:true,end_date:null,organization_id:'fixture-org',title:'Marketing Director'}]}}});
 const open=await new ApolloContacts(selected.ops as any,allowance,fetch,{operations:[]})
  .resolve(host,ROLE,company,false,packet(),SERVICE);
 expect(open.state).toBe('resolved');
 expect(open.email).toBe('avery@v4c.ai');
});

it('plans at most three searches and always leads with the researched roles',()=>{
 const plan=contactSearchPlan(ROLE,SERVICE);
 expect(plan.length).toBeLessThanOrEqual(3);
 expect(plan[0].titles[0]).toContain('Head of Marketing');
 expect(new Set(plan.flatMap(p=>p.titles.map(t=>t.toLowerCase()))).size)
  .toBe(plan.flatMap(p=>p.titles).length);
 // Every step carries the criteria it will be judged by.
 expect(plan.every(s=>s.accepted.length>0)).toBe(true);
});

it('names each unmet requirement separately',()=>{
 const stale={title:'Marketing Director',has_email:true,last_refreshed_at:'2020-01-01T00:00:00Z',organization:{name:company}};
 expect(candidateLimitations(stale,ROLE,company)).toEqual(['provider_data_stale']);
 const other={title:'Marketing Director',has_email:true,last_refreshed_at:new Date().toISOString(),organization:{name:'Someone Else'}};
 expect(candidateLimitations(other,ROLE,company)).toEqual(['employer_unconfirmed']);
 const good={title:'Marketing Director',has_email:true,last_refreshed_at:new Date().toISOString(),organization:{name:company}};
 expect(candidateLimitations(good,ROLE,company)).toEqual([]);
});
