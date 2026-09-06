import {it,expect} from 'vitest';
import {batchReport} from '../src/domain/batch-report';
import {reviewFixture} from './fixtures/review-packet';
it('keeps discovery failures, current human labels and actual checked drafts separate',()=>{
 const p=reviewFixture();p.mode='live';const pending={...p,research:undefined,draft:undefined,draftReview:undefined,state:'source_pending'};
 const report=batchReport([{id:'1',revision:1,packet_hash:'current',packet:p},{id:'2',revision:1,packet_hash:'second',packet:pending},{id:'3',revision:1,packet_hash:'fixture',packet:reviewFixture()}],[{opportunity_id:'1',packet_hash:'old',labels:{note:'stale'}}]);expect(report.discovered).toBe(2);expect(report.decisions).toBe(1);expect(report.humanRated).toBe(0);expect(report.checkedDrafts).toBe(1);
});
