import {expect,it} from 'vitest';
import {normalizeSam,samQuery,readSam} from '../src/providers/sam';
import {procurementReadiness,compareProcurementNotice,procurementPreparation} from '../src/domain/procurement';
const notice={noticeId:'fixture-notice',title:'CRM implementation discovery',fullParentPathName:'Fixture agency.Office',solicitationNumber:'CRM-1',postedDate:'2026-09-01',active:'Yes',type:'Sources Sought',responseDeadLine:'2026-10-01T17:00:00-04:00',description:'https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=fixture-notice&api_key=secret',resourceLinks:['https://sam.gov/attachment?api_key=secret','http://unsafe.invalid/'],uiLink:'https://sam.gov/opp/fixture-notice/view'};
it('holds expired, ambiguous, stale and awarded notices and distinguishes an RFI checklist from a checked bid',()=>{
 const now=new Date('2026-09-06T12:00:00Z'),n=normalizeSam({opportunitiesData:[{...notice,fullParentPathCode:'fixture.office'}]},now.toISOString())[0];
 expect(procurementReadiness(n,now)).toMatchObject({kind:'rfi',canPrepare:true,eligibility:'unknown'});
 for(const changed of [{...n,awarded:true},{...n,active:'no' as const},{...n,deadlineUtc:null},{...n,deadlineUtc:'2026-09-05T00:00:00Z'},{...n,observedAt:'2026-09-01T00:00:00Z'}])expect(procurementReadiness(changed,now).canPrepare).toBe(false);
 expect(compareProcurementNotice(n,{...n,observedAt:'2026-09-07T00:00:00Z'}).requiresNewReview).toBe(false);
 expect(compareProcurementNotice(n,{...n,snapshotHash:'amended'}).requiresNewReview).toBe(true);
 expect(()=>compareProcurementNotice(n,{...n,noticeId:'other'})).toThrow('different_procurement_notice');
 expect(procurementPreparation(n,now)).toMatchObject({status:'source_documents_required',title:'Prepare a capability response outline'});
});
it('preserves notice identity, offset deadlines and amendment snapshots without confusing retrieval time with an amendment',()=>{
 const a=normalizeSam({opportunitiesData:[notice]},'2026-09-06T00:00:00Z')[0];
 expect(a.deadlineUtc).toBe('2026-10-01T21:00:00.000Z');expect(a.descriptionUrl).not.toContain('secret');expect(a.attachmentUrls).toEqual(['https://sam.gov/attachment']);
 const b=normalizeSam({opportunitiesData:[notice]},'2026-09-07T00:00:00Z')[0];expect(a.snapshotHash).toBe(b.snapshotHash);
 const changed=normalizeSam({opportunitiesData:[{...notice,responseDeadLine:'2026-10-02 17:00:00'}]},b.observedAt)[0];
 expect(changed.noticeId).toBe(a.noticeId);expect(changed.snapshotHash).not.toBe(a.snapshotHash);expect(changed.deadlineUtc).toBeNull();
 expect(normalizeSam({opportunitiesData:[{...notice,type:'Award Notice',active:'No'}]},b.observedAt)[0]).toMatchObject({awarded:true,active:'no'});
});
it('bounds discovery and strips an echoed API credential before saving a provider response',async()=>{
 const old=process.env.SAM_GOV_API_KEY;process.env.SAM_GOV_API_KEY='fixture-key-do-not-persist';
 try{const query=samQuery('CRM',90,new Date('2026-09-06T12:00:00Z'));expect(query).toMatchObject({postedFrom:'06/08/2026',postedTo:'09/06/2026',limit:3,offset:0});
  const saved=await readSam(query,async(input,init)=>{const u=new URL(String(input));expect(u.hostname).toBe('api.sam.gov');expect(init?.redirect).toBe('error');return new Response(JSON.stringify({opportunitiesData:[],link:u.href}),{status:200});});
  expect(JSON.stringify(saved)).not.toContain(process.env.SAM_GOV_API_KEY!);expect(normalizeSam(saved.body,saved.observedAt)).toEqual([]);
 }finally{if(old===undefined)delete process.env.SAM_GOV_API_KEY;else process.env.SAM_GOV_API_KEY=old;}
});
