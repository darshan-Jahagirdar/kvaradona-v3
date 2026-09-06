import{it,expect}from'vitest';import{websiteSpecialistStep}from'../src/stages/website-specialist';import{reviewFixture}from'./fixtures/review-packet';
it('persists a failed capture and does not repeat it or spend model credits on the same input',async()=>{
 const p=reviewFixture();p.websiteRequest={profiles:['cro','aeo'],url:'https://fixture.invalid',question:'Verify the public offer.',requestedAt:new Date().toISOString(),verificationOnly:true};let captures=0;
 const tools={ai:{async generate(){throw Error('unexpected_model');}},websiteCapture:async()=>{captures++;throw Error('navigation_timeout');}};
 expect(await websiteSpecialistStep(p,tools)).toBe(null);expect(p.websiteFailure?.reason).toBe('capture_unavailable');expect(await websiteSpecialistStep(p,tools)).toBe(null);expect(captures).toBe(1);expect(p.state).toBe('website_pending');
});
