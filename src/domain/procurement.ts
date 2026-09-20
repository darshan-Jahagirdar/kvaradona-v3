import {randomUUID} from 'node:crypto';
import {supportedService} from './service-fit';
import type {ProcurementNotice} from '../providers/sam';

/** Procurement status is separate from service fit and supplier eligibility. */
export function procurementReadiness(n:ProcurementNotice,now=new Date()){
 const holds:string[]=[];
 if(n.awarded)holds.push('Award notice; not an open request for a new response.');
 if(n.active==='no')holds.push('Notice is archived or inactive.');
 if(n.active==='unknown')holds.push('Active status is unknown.');
 if(!n.deadlineUtc)holds.push('Response deadline or timezone is unverified.');
 else if(Date.parse(n.deadlineUtc)<=now.getTime())holds.push('The response deadline has passed.');
 if(!n.buyer||!n.buyerCode)holds.push('Buyer attribution requires confirmation.');
 if(Date.parse(n.observedAt)>now.getTime()||now.getTime()-Date.parse(n.observedAt)>86400000)holds.push('Refresh notice status and amendments before relying on it.');
 const kind=/sources sought/i.test(n.type??'')?'rfi':/^(solicitation|combined synopsis\/solicitation)$/i.test(n.type??'')?'solicitation':'other';
 if(kind==='other'&&!n.awarded)holds.push('Notice type requires review before preparing a response.');
 return {kind,holds,canPrepare:holds.length===0,eligibility:'unknown' as const};
}

/** Repeat snapshots do not create new notices. Material changes invalidate prior preparation. */
export function compareProcurementNotice(previous:ProcurementNotice,next:ProcurementNotice){
 if(previous.noticeId!==next.noticeId)throw Error('different_procurement_notice');
 return {sameNotice:true,changed:previous.snapshotHash!==next.snapshotHash,requiresNewReview:previous.snapshotHash!==next.snapshotHash};
}

/** A preparation checklist only: never label missing solicitation documents as a checked response. */
export function procurementPreparation(n:ProcurementNotice,now=new Date()){
 const readiness=procurementReadiness(n,now);
 return {
  noticeId:n.noticeId,snapshotHash:n.snapshotHash,readiness,
  status:'source_documents_required' as const,
  title:readiness.kind==='rfi'?'Prepare a capability response outline':'Prepare a procurement response outline',
  sourceUrl:n.url,
  sections:['Buyer requirements and exact response questions','Relevant delivery approach, conditional on confirmed scope','Verified company experience and supporting proof','Delivery assumptions, dependencies and clarification questions'],
  missingInputs:[
   'Current original notice description, attachments and all applicable amendments.',
   'Exact response route, submission instructions, deadline and timezone.',
   n.setAside?`Confirm eligibility for the notice’s stated set-aside: ${n.setAside}.`:'Confirm supplier eligibility and any set-aside requirements in the full documents.',
   'Your company’s legal bidder details, required registrations and verified proof.',
   ...(readiness.kind==='solicitation'?['Evaluation criteria, required pricing format and contractual exceptions.']:[]),
  ],
  limitations:['This is a preparation checklist, not a drafted or evidence-checked bid.','A published notice does not establish supplier eligibility. Submission remains outside this POC.'],
 };
}

export function procurementIdentity(n:ProcurementNotice){return `procurement:${n.source}:${n.buyerCode??'unresolved'}`;}

import type {Packet} from '../contracts/pipeline';
import {sourceQuote} from './policy';
export function procurementDraftProblems(p:Packet){
 const n=p.candidate?.procurementNotice;if(!n)return [];
 const errors:string[]=[];
 if(p.procurementDocuments?.snapshotHash!==n.snapshotHash)errors.push('Notice changed; collect current documents before drafting.');
 if(!p.draft?.procurement)return [...errors,'Procurement response details are missing.'];
 const d=p.draft.procurement;
 for(const item of [...d.requirements,...(d.responseRoute?[d.responseRoute]:[])]){
  const e=p.evidence.find(e=>e.id===item.evidenceId);
  if(!e||e.origin!=='original'||e.accountHost!==procurementIdentity(n)||!item.quote.trim()||sourceQuote(item.quote,e.text)!==item.quote.replace(/\s+/g,' ').trim())errors.push('Procurement requirement or response route lacks an exact original-source citation.');
 }
 if(p.draft.recipient!==null||p.draft.sender!==null)errors.push('Procurement preparation must not invent an email recipient or sender.');
 return errors;
}

/** Attach supporting notices to an existing company; do not replace its candidate or checked work. */
export function associateProcurement(p:Packet,source:Packet,now=new Date()){
 const n=source.candidate?.procurementNotice,c=p.candidate?.providerCompany;
 const host=c?.domain??p.research?.accountHost,name=c?.name??p.research?.company;
 if(!n||!host||!name||!n.buyer)return false;
 const key=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]/g,'');
 const originals=source.evidence.filter(e=>e.origin==='original'&&(e.accountHost===procurementIdentity(n)||e.accountHost===host));
 // Exact named buyer plus its original notice; a supplier/company mention is insufficient.
 if(key(n.buyer)!==key(name)||!originals.length)return false;
 const scope=originals.map(e=>e.text).join(' ');
 if(!supportedService(n.title+' '+scope))return false;
 const copies=originals.map(e=>p.evidence.find(v=>v.id===e.id||v.derivedFromEvidenceId===e.id)??{...e,id:randomUUID(),derivedFromEvidenceId:e.id});
 const ids=copies.map(e=>e.id),entry={notice:n,evidenceIds:ids,basis:'Exact named buyer and attributed original procurement evidence',scope:n.title,holds:procurementReadiness(n,now).holds};
 p.procurementContext=[...(p.procurementContext??[]).filter(v=>v.notice.source!==n.source||v.notice.noticeId!==n.noticeId),entry].slice(-5);
 p.evidence=[...new Map([...p.evidence,...copies].map(e=>[e.id,e])).values()];return true;
}
