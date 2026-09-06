import {it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {DiscoveryGroup} from '../src/contracts/discovery';
import {TheirStackCredits,unusedFreeCredits,theirStackRequest,normalizeTheirStack,searchTheirStack} from '../src/providers/theirstack';
import {testDatabase,localStore,seed,enqueue} from './database';
import {Job,Packet} from '../src/contracts/pipeline';
import {OperationGateway} from '../src/usage/operations';
import {runStage,type StageTools} from '../src/stages/pipeline';
import {hash,discoveryPriority} from '../src/domain/policy';
const group=DiscoveryGroup.parse({source:'theirstack',region:'US',country:'US',language:'en',jobDescriptionPatterns:['(?i)hubspot']}),at='2026-09-06T00:00:00.000Z';
const record={id:101,job_title:'Revenue Operations Manager',url:'https://listing.example.invalid/101',source_url:'https://listing.example.invalid/101',final_url:'https://company.example.invalid/jobs/101?utm_source=board',date_posted:'2026-09-01',discovered_at:'2026-09-02T00:00:00Z',closed_at:null,description:'The role includes HubSpot integrations and reporting. External delivery need is unknown.',country_codes:['US'],company_object:{name:'Synthetic Company',domain:'company.example.invalid',country_code:'GB'}};
const response={data:[record],metadata:{truncated_results:0}};
it('uses only the documented unused free allowance and bounds search filters and excluded IDs',()=>{
 const credits={api_credits:200,used_api_credits:0,earliest_expiration:'2026-10-06T00:00:00Z'};expect(unusedFreeCredits(credits)).toBe(200);expect(unusedFreeCredits({...credits,api_credits:1200,used_api_credits:190})).toBe(10);expect(unusedFreeCredits({...credits,used_api_credits:201})).toBe(0);expect(()=>TheirStackCredits.parse({...credits,api_credits:-1})).toThrow();
 const request=theirStackRequest(group,[3,1,3]);expect(request.job_id_not).toEqual([1,3]);expect(request.job_country_code_or).toEqual(['US']);expect(request).toMatchObject({limit:3,page:0,include_total_results:false,blur_company_data:false,is_closed:false,max_employee_count_or_null:10000});expect(()=>theirStackRequest(group,[],4)).toThrow();
});
it('keeps provider metadata separate, prefers a reported original URL, and accounts for skipped records',()=>{
 const normalized=normalizeTheirStack(response,group,at);const c=normalized.candidates[0];expect(c.url).toBe(record.final_url);expect(c.providerRecord).toMatchObject({kind:'provider_reported',companyDomain:'company.example.invalid',headquartersCountry:'GB',jobCountries:['US'],closedAt:null});expect(c.country).toBe('US');expect(c.eventKey).not.toContain('utm_source');
 const skipped=normalizeTheirStack(response,group,at,[101]);expect(skipped.candidates).toEqual([]);expect(skipped.providerResult.chargedCredits).toBe(1);
 const unsafe=normalizeTheirStack({...response,data:[{...record,url:'javascript:alert(1)',final_url:'https://user:password@bad.example.invalid/'}]},group,at);expect(unsafe.candidates).toEqual([]);expect(unsafe.providerResult.skipped[0].reason).toBe('source_url_unavailable');
 expect(()=>normalizeTheirStack({metadata:{},data:'unknown'},group,at)).toThrow();
});
it('prioritizes a reported direct-employer posting over a matching board-only lead using the full saved description',()=>{
 const direct=normalizeTheirStack(response,group,at).candidates[0];const board=normalizeTheirStack({...response,data:[{...record,id:102,final_url:null}]},group,at).candidates[0];
 direct.description='Introductory company text without service details.';expect(discoveryPriority(direct)).toBeGreaterThan(discoveryPriority(board));expect(direct.providerRecord?.kind).toBe('provider_reported');
});
it('reuses saved job-search responses and retains the full credit reservation without extra requests',async()=>{
 const db=await testDatabase();vi.stubEnv('THEIRSTACK_API_KEY','synthetic-provider-key');try{
  await seed(db);const store=localStore(db);await enqueue(db);const job=Job.parse(await store.rpc('claim_job',{p_worker:'fixture'}));await db.exec("update public.budget set live_enabled=true;update public.provider_limits set free_units=3,authenticated=true,usable=true,verified_at=now(),expires_at=now()+interval '1 hour' where provider='theirstack'");
  const gateway=new OperationGateway(store,job),fetcher=vi.fn(async()=>new Response(JSON.stringify(response),{status:200}));
  const first=await searchTheirStack(gateway,'search',group,[],fetcher as typeof fetch);const second=await searchTheirStack(gateway,'search',group,[],fetcher as typeof fetch);expect(second).toEqual(first);expect(fetcher).toHaveBeenCalledTimes(1);
  const ops=(await db.query<{units:number;actual_usd:string;usage:{actual_credits:number}}>('select units,actual_usd::text,usage from public.provider_operations')).rows;expect(ops[0]).toMatchObject({units:3,actual_usd:'0.00000000',usage:{actual_credits:1}});
  await expect(searchTheirStack(gateway,'another',group,[],fetcher as typeof fetch)).rejects.toThrow('free_quota_unverified_or_exhausted');expect(fetcher).toHaveBeenCalledTimes(1);
 }finally{vi.unstubAllEnvs();await db.close();}
});
it('holds unavailable or mismatched original attribution before AI/contact calls and preserves the provider lead',async()=>{
 for(const condition of ['unavailable','mismatch','supported'] as const){
  const candidate=normalizeTheirStack(response,group,at).candidates[0],packet=Packet.parse({mode:'fixture',state:'discovered',evidence:[],candidate}),calls:{output:Packet;next:unknown}[]=[];
  const job=Job.parse({id:randomUUID(),organization_id:randomUUID(),campaign_id:randomUUID(),opportunity_id:randomUUID(),stage:'S04',business_key:'fixture',input_hash:hash(packet),input_version:1,schema_version:'1',prompt_version:'8',attempt_token:randomUUID(),attempts:1,payload:packet});
  const tools={fetchEvidence:async()=>{if(condition==='unavailable')throw Error('source_http_403');return {id:randomUUID(),url:candidate.url,finalUrl:candidate.url,title:'Synthetic role',text:'A sufficiently long synthetic source describing HubSpot implementation responsibilities.',contentHash:'fixture',retrievedAt:at,publishedAt:'2026-09-01',source:'fixture',origin:'original',status:'unknown',accountHost:condition==='mismatch'?'different.example.invalid':'company.example.invalid'};},ai:{generate:()=>{throw Error('unexpected_ai_call');}},contact:()=>{throw Error('unexpected_contact_call');}} as unknown as StageTools;
  await runStage({async rpc(_name,args){calls.push({output:Packet.parse(args.p_output),next:args.p_next});return true;}},job,tools);
  expect(calls[0].output.candidate?.providerRecord?.id).toBe('101');expect(calls[0].output.state).toBe(condition==='unavailable'?'source_pending':condition==='mismatch'?'identity_conflict':'evidence_collected');expect(Boolean(calls[0].next)).toBe(condition==='supported');
 }
});
