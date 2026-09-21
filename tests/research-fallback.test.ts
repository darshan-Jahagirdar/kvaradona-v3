import {it,expect} from 'vitest';
import {companyContextQueries,contextLedQueries} from '../src/domain/company-discovery';
import {matchedTopicProfiles} from '../src/domain/intent-topics';
import {selectedRunSummary} from '../src/domain/selected-run';

const now=new Date().toISOString();
/** Mirrors this cohort: old Pardot metadata that matches no configured six-topic family. */
const pardot={provider:'explorium' as const,id:'p'.repeat(32),kind:'provider_reported' as const,name:'v4c.ai',
 domain:'v4c.ai',headquartersCountry:'united states',employees:null,employeeRange:'201-500',industry:'IT Services',
 observedAt:now,sourceUrl:'https://api.explorium.ai/v2/businesses',
 provenance:{name:'name' as const,domain:'domain' as const,headquartersCountry:'country_name' as const,
  employees:'number_of_employees_range' as const,industry:'naics_description' as const},
 icp:{status:'unknown' as const,reasons:[],unknowns:[],searchCountry:'US'},
 intent:{status:'provider_reported' as const,reason:'topic research',
  topics:[{topic:'media & advertising: pardot',score:73,sourceDate:null}]}};

it('confirms this cohort matches no configured intent family',()=>{
 expect(matchedTopicProfiles(pardot)).toHaveLength(0);
});

it('asks context-led questions instead of one generic keyword group',()=>{
 const queries=companyContextQueries(pardot,'','Databricks consultancy delivering data engineering');
 expect(queries).toHaveLength(3);
 // The old fallback asked this of every unmatched company.
 expect(queries.some(q=>q.query.includes('(website OR CRM OR marketing)'))).toBe(false);
 // Every question is restricted to the company's own domain.
 expect(queries.every(q=>q.query.startsWith('site:v4c.ai'))).toBe(true);
 // One asks what they sell, grounded in their own recorded description.
 expect(queries[0].query.toLowerCase()).toContain('databricks');
 // One asks where a visitor is asked to act, which is what a CRO offer needs.
 expect(queries[1].query).toContain('demo');
 expect(queries.map(q=>q.question)).toEqual([
  'What does this company actually sell, and to whom?',
  'Where does the site ask a visitor to act, and what does that path look like?',
  'What has the company published recently that a conversation could reference?']);
});

it('falls back to service terms when no description is recorded, without inventing intent',()=>{
 const bare={...pardot,industry:null};
 const queries=contextLedQueries(bare,'');
 expect(queries[0].query).toBe('site:v4c.ai (services OR solutions OR products)');
 expect(JSON.stringify(queries)).not.toMatch(/pardot|intent|hubspot/i);
});

it('keeps the matched-family plan when a family does match',()=>{
 const matched={...pardot,intent:{status:'provider_reported' as const,reason:'r',
  topics:[{topic:'website publishing: website design',score:70,sourceDate:'2026-09-01'}]}};
 expect(matchedTopicProfiles(matched).length).toBeGreaterThan(0);
 const queries=companyContextQueries(matched,'','');
 expect(queries[0].question).toBe('Which dated company initiative connects to the service?');
});

it('an explicit reviewer question still overrides the fallback',()=>{
 const queries=companyContextQueries(pardot,'What does their appointment journey show?','desc');
 expect(queries[0].question).toBe('What does their appointment journey show?');
});

it('surfaces a reviewer question only once automatic resolution is exhausted',()=>{
 const base={mode:'live',state:'source_pending',evidence:[],notes:[]};
 const asking=selectedRunSummary({run:{id:'r'},jobs:[],members:[{opportunityId:'o',entryRevision:2,currentRevision:2,
  resultRevision:2,state:'source_pending',entryState:'discovered',queuedStage:'S03',
  packet:{...base,pendingResolution:{reason:'identity_unresolved',detail:'No structured employer identity.',
   attempts:1,nextAction:'ask_reviewer',question:'Which company does this listing belong to?',at:now}}}]});
 expect(asking.members[0].reviewerQuestion?.question).toBe('Which company does this listing belong to?');

 const retrying=selectedRunSummary({run:{id:'r'},jobs:[],members:[{opportunityId:'o',entryRevision:2,currentRevision:2,
  resultRevision:2,state:'source_pending',entryState:'discovered',queuedStage:'S03',
  packet:{...base,pendingResolution:{reason:'identity_unresolved',detail:'trying',attempts:1,
   nextAction:'retry_resolution',at:now}}}]});
 // Still resolvable automatically, so the reviewer is not asked yet.
 expect(retrying.members[0].reviewerQuestion).toBeNull();
});

it('carries the question\'s reason and the options actually tried, so the UI can answer the right one',()=>{
 const base={mode:'live',state:'source_pending',evidence:[],notes:[]};
 const card=(packet:Record<string,unknown>)=>selectedRunSummary({run:{id:'r'},jobs:[],
  members:[{opportunityId:'o',entryRevision:2,currentRevision:2,resultRevision:2,state:'source_pending',
   entryState:'discovered',queuedStage:'S03',packet:{...base,...packet}}]}).members[0];

 // An identity question names its reason and what automatic identification already tried, so the
 // panel can offer the structured hint form and show that the question is a last resort.
 const identity=card({pendingResolution:{reason:'identity_unresolved',detail:'No structured employer identity.',
  attempts:2,nextAction:'ask_reviewer',at:now,attempted:['The listing carries no structured employer field.',
   'Reviewer answer "Example" (example.test): that site publishes no structured identity for the name given.'],
  question:'Which company does this listing belong to?'}});
 expect(identity.reviewerQuestion?.reason).toBe('identity_unresolved');
 expect(identity.reviewerQuestion?.attempted).toHaveLength(2);

 // A classification question is a DIFFERENT question. The identity action would be refused for it,
 // so the reason must reach the UI rather than every question rendering one universal form.
 const classification=card({state:'company_assessment_pending',
  pendingResolution:{reason:'classification_conflict',detail:'Saved attributes leave an unresolved conflict.',
   attempts:1,nextAction:'ask_reviewer',at:now,question:'Does this company belong in this campaign?'}});
 expect(classification.reviewerQuestion?.reason).toBe('classification_conflict');
 // Nothing was recorded as tried, and the card says so rather than implying exhaustion.
 expect(classification.reviewerQuestion?.attempted).toEqual([]);

 // A question still under automatic resolution is not put to a reviewer at all.
 expect(card({pendingResolution:{reason:'classification_conflict',detail:'working',attempts:1,
  nextAction:'retry_resolution',at:now}}).reviewerQuestion).toBeNull();
});
