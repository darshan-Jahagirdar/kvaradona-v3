import {expect,it} from 'vitest';
import {ApolloContacts,type ContactOperations} from '../src/providers/apollo';
const recent=new Date().toISOString();
const candidate={id:'person-fixture',first_name:'Alex',last_name_obfuscated:'Te***r',title:'Head of Revenue Operations',last_refreshed_at:recent,has_email:true,organization:{name:'Fixture Systems'}};
const person={id:candidate.id,name:'Alex Tester',title:candidate.title,email:'alex@fixture.invalid',email_status:'verified',organization_id:'org-fixture',organization:{id:'org-fixture',name:'Fixture Systems',primary_domain:'fixture.invalid'},employment_history:[{current:true,end_date:null,organization_id:'org-fixture',title:candidate.title}]};
const allowance={remaining:75,expiresAt:new Date(Date.now()+3600000).toISOString(),evidence:'Fixture: user-confirmed free quota only',verifiedFree:true};
function harness(results:unknown[]){const calls:{key:string,units:number}[]=[];const store:ContactOperations={async run(key,_provider,_request,max,units,validate,_dispatch){calls.push({key,units});expect(max).toBe('0');return validate.parse(results.shift());}};return {calls,resolver:(credit=allowance)=>new ApolloContacts(store,credit)};}
it('preserves buyer candidates without revealing an email when free credit is unavailable',async()=>{
 const h=harness([{httpStatus:200,body:{people:[candidate]}}]);const c=await h.resolver({...allowance,remaining:0}).resolve('fixture.invalid','Revenue Operations lead','Fixture Systems');
 expect(c.state).toBe('contact_pending');expect(c.email).toBeNull();expect(c.name).toBeNull();expect(c.candidates?.[0].displayName).toBe('Alex Te***r');expect(h.calls).toEqual([{key:'contact_search',units:0}]);
});
it('requires current employment and a verified work-domain email, using at most one enrichment',async()=>{
 for(const changed of [{},{employment_history:[{current:false,end_date:'2025-01-01',organization_id:'org-fixture'}]},{email:'alex@personal.invalid'},{email_status:'catch_all'},{id:'wrong-person'},{title:'Intern'}]){
  const h=harness([{httpStatus:200,body:{people:[candidate]}},{httpStatus:200,body:{person:{...person,...changed}}}]);const c=await h.resolver().resolve('fixture.invalid','Revenue Operations lead','Fixture Systems');
  expect(c.state).toBe(Object.keys(changed).length?'contact_pending':'resolved');expect(h.calls).toEqual([{key:'contact_search',units:0},{key:'contact_enrichment',units:1}]);
 }
});
it('does not treat denied access or mismatched company results as a resolved contact',async()=>{
 for(const response of [{httpStatus:403,body:{error:'unauthorized'}},{httpStatus:200,body:{people:[{...candidate,organization:{name:'Different employer'}}]}}]){
  const h=harness([response]);const c=await h.resolver().resolve('fixture.invalid','Revenue Operations lead','Fixture Systems');expect(c.state).toBe('contact_pending');expect(c.email).toBeNull();expect(h.calls).toHaveLength(1);
 }
});
it('normalizes approved CMO and CEO titles before role relevance and seniority checks',async()=>{
 for(const title of ['CMO','Chief Marketing Officer','CEO']){
 const h=harness([{httpStatus:200,body:{people:[{...candidate,title}]}},{httpStatus:200,body:{person:{...person,title}}}]);
 const result=await h.resolver().resolve('fixture.invalid',title==='CEO'?'CEO':'Marketing','Fixture Systems',true);
 expect(result.state).toBe('resolved');expect(h.calls).toHaveLength(2);
 }
});
