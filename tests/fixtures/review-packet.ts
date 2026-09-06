import {randomUUID} from 'node:crypto';
import {Packet} from '../../src/contracts/pipeline';
import {hash,contactPending} from '../../src/domain/policy';
export function reviewFixture(){
 const eid=randomUUID(),fact='Fixture Systems announced a CRM migration.';
 const p=Packet.parse({mode:'fixture',state:'contact_pending',evidence:[{id:eid,url:'https://fixture.invalid/news',finalUrl:'https://fixture.invalid/news',title:'Migration',text:fact,contentHash:hash(fact),retrievedAt:new Date().toISOString(),publishedAt:null,source:'fixture',origin:'original',status:'unknown',accountHost:'fixture.invalid'}],research:{company:'Fixture Systems',accountHost:'fixture.invalid',identityBasis:fact,service:'CRM',demand:'initiative',whyNow:fact,offer:'Offer an implementation outline.',buyerRole:'Revenue Operations lead',claims:[{id:'c1',text:fact,quote:fact,evidenceId:eid,kind:'fact',material:true}],contrary:[],uncertainties:['Delivery status unknown.'],decision:'exploration',reason:'Relevant initiative.',watchTrigger:null,specialist:'none',specialistReason:'No specialist question.',followUp:null},draft:{subject:'CRM outline',body:'Would a short implementation outline help?',recipient:null,sender:null,claimIds:['c1']},contact:contactPending('Revenue Operations lead','Fixture')});
 const review={acceptable:true,issues:[],verdicts:[{claimId:'c1',verdict:'supported',evidenceIds:[eid],repair:''}]};
 p.packetReview={...review,inputHash:hash(JSON.stringify(p.research))} as Packet['packetReview'];p.draftReview={...review,inputHash:hash(JSON.stringify(p.draft))} as Packet['draftReview'];
 return p;
}
