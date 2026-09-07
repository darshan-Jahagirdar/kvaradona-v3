import {expect,it} from 'vitest';
import {reviewFixture} from './fixtures/review-packet';
import {reviewPlacement,groupOpportunities} from '../src/domain/opportunity-review';
import {Packet} from '../src/contracts/pipeline';
import {hash,discoveryPriority} from '../src/domain/policy';
import {workflowSummary,type WorkflowStatus} from '../src/domain/workflow-status';
it('keeps checked exploratory and contact-pending prospects in the main view without claiming buying intent',()=>{
 const p=reviewFixture();p.mode='live';expect(reviewPlacement(p).section).toBe('opportunities');expect(reviewPlacement(p).need).toContain('purchase unconfirmed');
 p.draft!.body+=' edit';expect(reviewPlacement(p).section).toBe('human');
});
it('distinguishes clear rejection, unattributed sources, identity conflicts and grouped company opportunities',()=>{
 const p=reviewFixture();p.mode='live';p.state='service_mismatch';expect(reviewPlacement(p)).toMatchObject({section:'human',rejected:true});
 const source=Packet.parse({mode:'live',state:'source_pending',evidence:[]});expect(reviewPlacement(source).section).toBe('sources');
 p.state='source_pending';delete p.draft;expect(reviewPlacement(p)).toMatchObject({section:'human',rejected:false});
 const row={revision:1,packet_hash:hash(p),packet:p};expect(groupOpportunities([{...row,id:'a'},{...row,id:'b'}])).toHaveLength(1);
 p.evidence[0].accountHost='publisher.invalid';expect(reviewPlacement(p).section).toBe('sources');
});
it('prioritizes service-specific requests without excluding useful exploration',()=>{
 const base={url:'https://company.invalid/project',title:'CRM implementation request for proposal',description:'Seeking a partner'};
 expect(discoveryPriority(base)).toBeGreaterThan(discoveryPriority({...base,title:'Revenue operations HubSpot migration job',description:''}));
 expect(discoveryPriority({...base,title:'CRM implementation RFP template guide'})).toBeLessThan(0);
});
it('reports offline, queued, running, failure and budget states from real jobs',()=>{
 const s:WorkflowStatus={run:{id:'run',created_at:''},worker:{online:false,seenAt:null},budget:{live_enabled:true},jobs:[{id:'j',opportunity_id:null,stage:'S02',status:'queued',error:null}],opportunities:[]};
 expect(workflowSummary(s).phase).toBe('Waiting for laptop worker');s.worker.online=true;expect(workflowSummary(s).phase).toBe('Queued');s.jobs[0].status='running';expect(workflowSummary(s).phase).toBe('Running');s.jobs[0].status='blocked';s.jobs[0].error='budget_paused';expect(workflowSummary(s).phase).toBe('Paused by budget');s.jobs[0].error='source_unavailable';expect(workflowSummary(s).phase).toBe('Finished with issues');
});
