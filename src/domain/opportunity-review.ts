import type {Packet} from '../contracts/pipeline';
import {reviewProblems,validateResearch} from './policy';
import {draftResearch} from './crm-specialist';
import {procurementDraftProblems} from './procurement';
export type ReviewSection='opportunities'|'human'|'sources';
export function companyIdentity(p:Packet):{key:string;name:string;basis:string}|null {
 const n=p.candidate?.procurementNotice;
 if(n?.buyer)return {key:`procurement:${n.buyer.trim().toLowerCase()}`,name:n.buyer,basis:'Named procurement buyer'};
 const r=p.research;
 if(r&&p.evidence.some(e=>e.origin==='original'&&e.accountHost===r.accountHost)&&!/^unresolved|^unknown$/i.test(r.company))return {key:r.accountHost.toLowerCase().replace(/^www\./,''),name:r.company,basis:'Attributed original source'};
 const company=p.candidate?.providerCompany;
 if(company)return {key:company.domain??`apollo:${company.id}`,name:company.name,basis:'Apollo reported · original identity and need require research'};
 const provider=p.candidate?.providerRecord;
 if(provider?.company&&provider.companyDomain)return {key:provider.companyDomain.toLowerCase().replace(/^www\./,''),name:provider.company,basis:'Provider reported · identity needs checking'};
 return null;
}
export function reviewPlacement(p:Packet){
 const identity=companyIdentity(p),rejected=['rejected','disqualified','service_mismatch'].includes(p.state)||p.research?.decision==='disqualified';
 const checked=Boolean(p.research&&p.packetReview&&p.draft&&p.draftReview&&!reviewProblems(p.packetReview,p.research,p,JSON.stringify(p.research)).length&&!reviewProblems(p.draftReview,draftResearch(p),p,JSON.stringify(p.draft)).length&&!procurementDraftProblems(p).length);
 const eligible=identity&&p.mode==='live'&&!rejected&&!['deferred','watch','relationship_handoff','research_requested','review_required'].includes(p.state)&&['priority','exploration'].includes(p.research?.decision??'')&&checked&&(!p.writingReview||p.writingReview.acceptable); 
 const section:ReviewSection=eligible?'opportunities':identity?'human':'sources';
 const supported=p.research&&!validateResearch(p.research,p).length&&p.packetReview?.acceptable;
 const need=supported?({external_demand:'Explicit request · verify current scope',initiative:'Relevant initiative · purchase unconfirmed',plausible:'Plausible fit · purchase unconfirmed',weak:'Insufficient evidence of need'}[p.research!.demand]):'Need not established';
 const readiness=rejected?'Rejected':checked?'Checked draft · human review needed':p.draft?'Draft needs checking':'Research incomplete';
 return {identity,section,rejected,checked,need,readiness};
}
export type ReviewItem={id:string;revision:number;packet_hash:string;packet:Packet};
export function groupOpportunities(items:ReviewItem[]){
 const groups=new Map<string,{key:string;name:string;items:ReviewItem[]}>();
 for(const item of items){const identity=companyIdentity(item.packet),key=identity?.key??item.id;const group=groups.get(key)??{key,name:identity?.name??'Unattributed source',items:[]};group.items.push(item);groups.set(key,group);}
 return [...groups.values()];
}
