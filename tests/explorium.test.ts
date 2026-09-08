import {activeIntentTopics} from '../src/domain/intent-topics';
const exploriumPilotTopic=activeIntentTopics[0];
import {it,expect} from 'vitest';
import {exploriumCandidates,applyExploriumIntent,searchExploriumCompanies,callExplorium} from '../src/providers/explorium';
import {exploriumFilters,exploriumIcp,exploriumPageSize} from '../src/domain/explorium-icp';
import {DiscoveryGroup} from '../src/contracts/discovery';
const id='a'.repeat(32),date='20260906';
const row={business_id:id,name:'Example Software',domain:'example.com',country_name:'united kingdom',number_of_employees_range:'501-1000',naics_description:'Software Publishers',business_description:'Business software',business_intent_topics:[{topic:exploriumPilotTopic,score:63}]};
const page=(rows=[row])=>({data:rows,page:{next_cursor:'next'},credit_usage:{total_credits:rows.length*2}});
const detail=(topic=exploriumPilotTopic,stamp=date)=>({data:[{business_id:id,data:{business_id:id,company_website:'example.com',date_stamp:stamp,intent_topics:JSON.stringify([{topic,composite_score:63}])}}],credit_usage:{total_credits:2}});
it('uses all seven countries, supported industry filters, six topic families, and handles the exactly-500 boundary honestly',()=>{
 expect(exploriumFilters().country_code.values).toEqual(['in','us','gb','au','nz','ae','sg']);expect(exploriumFilters().linkedin_category.values).toContain('hospitality');expect(exploriumFilters().business_intent_topics.topics).toEqual(activeIntentTopics);expect(exploriumFilters().company_size.values).toEqual(['501-1000','1001-5000','5001-10000']);expect(exploriumPageSize).toBe(4);expect(exploriumIcp(row).status).toBe('match');expect(exploriumIcp({...row,number_of_employees_range:'201-500'}).status).toBe('unknown');expect(exploriumIcp({...row,number_of_employees_range:'11-50'}).status).toBe('mismatch');expect(exploriumIcp({...row,business_description:'Broadband provider'}).status).toBe('unknown');
});
it('requires the actual requested topic and excludes deleted companies and subdomains',()=>{
 expect(exploriumCandidates(page([{...row,domain:'github.com'}])).candidates).toEqual([]);expect(exploriumCandidates(page([{...row,domain:'news.forbes.com'}])).candidates).toEqual([]);expect(()=>exploriumCandidates(page([{...row,business_intent_topics:[{topic:'other',score:90}]}]))).toThrow('explorium_intent_results_invalid');
});
it('requires matching company, topic and current valid source date; general interest is not dated intent',()=>{
 const make=()=>exploriumCandidates(page()).candidates[0];const now=new Date('2026-09-07T12:00:00Z');
 expect(applyExploriumIntent(make(),detail(),now).providerCompany!.intent).toMatchObject({status:'provider_reported',topics:[{sourceDate:'2026-09-06',score:63}]});
 for(const d of [detail('other'),detail(exploriumPilotTopic,'20250101'),detail(exploriumPilotTopic,'20260230'),{data:[]}])expect(applyExploriumIntent(make(),d,now).providerCompany!.intent.status).toBe('unknown');
 const wrong=detail();wrong.data[0].data.company_website='wrong.example';expect(applyExploriumIntent(make(),wrong,now).providerCompany!.intent.status).toBe('unknown');
});
it('reserves two credits per requested company, uses actual credit reports and halts denial or uncertain usage without a second provider call',async()=>{
 process.env.EXPLORIUM_API_KEY='fixture-key';let calls=0;
 const operations={run:async(_key:any,_provider:any,_body:any,_usd:any,units:number,_schema:any,dispatch:any)=>{expect(units).toBe(2*exploriumPageSize);return (await dispatch()).response;}} as any;
 const request=(async()=>{calls++;return new Response(JSON.stringify({detail:'denied'}),{status:403});}) as typeof fetch;
 await expect(searchExploriumCompanies(operations,'test',DiscoveryGroup.parse({source:'explorium',country:'US',language:'en'}),request)).rejects.toThrow('explorium_intent_access_denied');expect(calls).toBe(1);
 await expect(callExplorium(operations,'test','businesses',{},2*exploriumPageSize,(async()=>new Response(JSON.stringify({data:[]}))) as typeof fetch)).rejects.toThrow('explorium_credit_usage_unknown');
 await expect(callExplorium(operations,'test','businesses',{},2*exploriumPageSize,(async()=>new Response(JSON.stringify({credit_usage:{total_credits:2*exploriumPageSize+1}}))) as typeof fetch)).rejects.toThrow('explorium_credit_reservation_exceeded');
});

it('recognizes the approved buyer-title families without admitting unrelated roles',async()=>{const {intentBuyerTitle}=await import('../src/providers/apollo');for(const t of ['CMO','Chief Executive Officer','VP Marketing','Vice President of Sales','Head of Revenue Operations','Sales Manager','Head of Sales'])expect(intentBuyerTitle(t)).toBe(true);for(const t of ['Software Engineer','Marketing Intern','Director of Design'])expect(intentBuyerTitle(t)).toBe(false);});
