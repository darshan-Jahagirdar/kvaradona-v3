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
 if(now.getTime()-Date.parse(n.observedAt)>86400000)holds.push('Refresh notice status and amendments before relying on it.');
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
