import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Packet,Research,Review} from '../src/contracts/pipeline';
import {hash,reviewProblems} from '../src/domain/policy';
it('accepts an attributable version of the same page for non-factual claims without permitting unrelated or changed fact anchors',()=>{
 const old=randomUUID(),current=randomUUID(),text='Fixture Systems describes a CRM initiative.';
 const evidence={url:'https://fixture.invalid/news',finalUrl:'https://fixture.invalid/news',title:'Initiative',text,contentHash:hash(text),retrievedAt:new Date().toISOString(),publishedAt:null,source:'fixture',origin:'original',status:'unknown',accountHost:'fixture.invalid'};
 const research=Research.parse({company:'Fixture Systems',accountHost:'fixture.invalid',identityBasis:text,service:'CRM',demand:'plausible',whyNow:'Potential fit.',offer:'Offer a scope discussion.',buyerRole:'Operations',claims:[{id:'c1',text:'Outside implementation support could help.',kind:'inference',evidenceId:old,quote:'',material:true}],contrary:[],uncertainties:[],decision:'exploration',reason:'Potential fit only.',watchTrigger:null,specialist:'none',specialistReason:'None',followUp:null});
 const p=Packet.parse({mode:'fixture',state:'contact_pending',evidence:[{...evidence,id:old},{...evidence,id:current}],research});
 const target='exact message',review=Review.parse({acceptable:true,issues:[],inputHash:hash(target),verdicts:[{claimId:'c1',verdict:'inference',evidenceIds:[current],repair:''}]});
 expect(reviewProblems(review,research,p,target)).toEqual([]);
 for(const change of [{finalUrl:'https://fixture.invalid/other'},{accountHost:'other.invalid'},{origin:'provider_reported'}]){
  const changed=Packet.parse({...p,evidence:[p.evidence[0],{...p.evidence[1],...change}]});expect(reviewProblems(review,research,changed,target)).toContain('Invalid review citation:c1');
 }
 const fact=Research.parse({...research,claims:[{...research.claims[0],kind:'fact',text,quote:text}]});
 expect(reviewProblems({...review,verdicts:[{...review.verdicts[0],verdict:'supported'}]},fact,p,target)).toContain('Invalid review citation:c1');
 expect(reviewProblems({...review,verdicts:[{...review.verdicts[0],evidenceIds:[randomUUID()]}]},research,p,target)).toContain('Invalid review citation:c1');
});
