import {expect,it} from 'vitest';
import {extractEvidence} from '../src/capture/fetch';
import {discoveryPriority} from '../src/domain/policy';
const description='Our team is implementing HubSpot lead routing across sales and customer success. This role owns workflows and reporting. We may deliver this work internally.';
const page=(hiringOrganization:unknown,validThrough?:string)=>`<html><head><script type="application/ld+json">${JSON.stringify({'@graph':[{'@type':'JobPosting',title:'Revenue Operations',description,hiringOrganization,datePosted:'2026-08-01',validThrough}]})}</script></head><body><main>${description}</main></body></html>`;
it('prioritizes specific attributable job evidence over guides and general career indexes',()=>{
 const job={url:'https://jobs.lever.co/fixture/one',title:'Revenue Operations Analyst',description};
 expect(discoveryPriority(job)).toBeGreaterThan(discoveryPriority({url:'https://boards.greenhouse.io/fixture',title:'All Openings',description:'HubSpot jobs'}));
 expect(discoveryPriority(job)).toBeGreaterThan(discoveryPriority({url:'https://publisher.example.test/guide',title:'HubSpot RFP Template Guide',description}));
});
it('attributes a hosted employer job from structured evidence and preserves expiry as contrary evidence',()=>{
 const e=extractEvidence('https://jobs.lever.co/northstar/one','https://jobs.lever.co/northstar/one',page({name:'Northstar Fixture',sameAs:'https://northstar.example.test'},'2026-08-31'),new Date('2026-09-06T12:00:00Z'));
 expect(e.accountHost).toBe('northstar.example.test');expect(e.status).toBe('closed');expect(e.text).toContain('Hiring organization: Northstar Fixture.');expect(e.text).toContain(description);
});
it('keeps board/recruiter identity unresolved without attributing a third-party listing to an inferred client',()=>{
 const e=extractEvidence('https://jobs.ashbyhq.com/agency/one','https://jobs.ashbyhq.com/agency/one',page({name:'Recruiter for an unnamed client'}));
 expect(e.accountHost).toBeNull();expect(e.status).toBe('unknown');
 const aggregated=extractEvidence('https://www.jobleads.com/job/one','https://www.jobleads.com/job/one',page({name:'Northstar Fixture',sameAs:'https://northstar.example.test'}));
 expect(aggregated.origin).toBe('provider_reported');expect(aggregated.accountHost).toBeNull();
});
it('uses an explicitly named employer homepage link without guessing a domain from the board slug',()=>{
 const html=page({name:'Northstar Fixture'})+'<a href="https://northstar.example.test">Northstar Fixture Home Page</a><a href="https://unrelated.example.test">Support</a>';
 expect(extractEvidence('https://jobs.lever.co/other-slug/one','https://jobs.lever.co/other-slug/one',html).accountHost).toBe('northstar.example.test');
});
