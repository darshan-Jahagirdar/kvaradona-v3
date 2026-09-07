import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {reviewFixture} from './fixtures/review-packet';
import {runStage,type StageTools} from '../src/stages/pipeline';
import {Job,type Packet} from '../src/contracts/pipeline';
import {draftHasAnchor} from '../src/domain/draft-quality';
it('requires an attributable fact, while allowing unknown intent',()=>{const p=reviewFixture();expect(draftHasAnchor(p)).toBe(true);p.research!.claims[0].kind='unknown';expect(draftHasAnchor(p)).toBe(false);});
it('assesses writing separately in the same fact-check call and preserves exact human wording',async()=>{
 const p=reviewFixture();p.draftCheckRequest={requestedAt:new Date().toISOString(),reviewerId:randomUUID()};const before=structuredClone(p.draft),calls:string[]=[];let result:Packet|undefined;
 const tools:StageTools={ai:{async generate(role,_key,schema,_rules,input){calls.push(role);return schema.parse({...p.draftReview,inputHash:(input as {inputHash:string}).inputHash,writing:{acceptable:false,relevance:'needs_work',offerClarity:'clear',naturalWriting:'needs_work',nextStep:'clear',issues:['The message needs a specific company anchor.']}});}},fetchEvidence:async()=>{throw Error('unexpected_fetch');},search:async()=>{throw Error('unexpected_search');},relationship:async()=>'unknown',contact:async()=>{throw Error('unexpected_contact');}};
 const job=Job.parse({id:randomUUID(),organization_id:randomUUID(),campaign_id:randomUUID(),opportunity_id:randomUUID(),stage:'S11',business_key:'writing',input_hash:'test',input_version:1,schema_version:'1',prompt_version:'11',attempt_token:randomUUID(),attempts:1,payload:p});
 await runStage({async rpc(name,args){expect(name).toBe('complete_job');result=args.p_output as Packet;return true;}},job,tools);
 expect(calls).toEqual(['A5']);expect(result!.draft).toEqual(before);expect(result!.draftReview?.acceptable).toBe(true);expect(result!.writingReview?.acceptable).toBe(false);expect(result!.state).toBe('draft_writing_review');
});
