import {Packet} from '../contracts/pipeline';
import {reviewProblems} from './policy';
import {draftResearch} from './crm-specialist';
import {writingReviewCurrent,draftHasAnchor} from './draft-quality';
import {packetReadiness} from './recovery';

/** `new` and `updated` mean a stage of THIS run completed and produced the packet being reported.
 *  `reused` means the run has not changed the account's result. `superseded` means a later run has
 *  moved the packet past the revision this run completed, so this run no longer owns the result. */
export type MemberOutcome='new'|'updated'|'reused'|'superseded'|'pending'|'held'|'failed';

export interface MemberCard {
 opportunityId:string;
 name:string;
 host:string|null;
 state:string;
 stage:string|null;
 attempts:number;
 outcome:MemberOutcome;
 /** True only when a stage of this run completed and the reported packet is that exact revision. */
 producedInThisRun:boolean;
 entryRevision:number|null;
 resultRevision:number|null;
 currentRevision:number|null;
 finding:string|null;
 offer:string|null;
 contact:{name:string|null;role:string|null;email:string|null;state:string;boundToDraft:boolean}|null;
 draft:{subject:string;body:string;checked:boolean;recipient:string|null}|null;
 sources:{url:string;title:string;retrievedAt:string}[];
 readiness:ReturnType<typeof packetReadiness>|null;
 blockedReason:string|null;
 /** Set only once automatic resolution is exhausted: the one thing a reviewer can answer. */
 reviewerQuestion:{question:string;detail:string;reason:string}|null;
}

const terminalStates=new Set(['rejected','disqualified','relationship_handoff','icp_mismatch','service_mismatch','watch']);
const completedStates=new Set(['review_ready','contact_pending']);

/** A checked draft requires BOTH reviews to match this exact draft text, and the recipient to be the
 *  resolved contact. A present-but-stale review is not a check. */
export function draftIsChecked(p:ReturnType<typeof Packet.parse>){
 if(!p.draft||!p.draftReview||!p.research)return false;
 if(p.writingReview?.acceptable!==true||!writingReviewCurrent(p))return false;
 if(p.draft.recipient!==(p.contact?.email??null))return false;
 return !reviewProblems(p.draftReview,draftResearch(p),p,JSON.stringify(p.draft)).length;
}

/** The technical floor, computed from the packet so it cannot be marked up by hand.
 *  Passing it means the pieces are present and current. It is NOT a judgement that the finding is
 *  commercially strong; that remains a separate human rating. */
export function meetsUsefulFloor(card:MemberCard){
 if(!card.producedInThisRun)return false;
 if(card.outcome==='pending'||card.outcome==='failed'||card.outcome==='held'||card.outcome==='superseded')return false;
 if(!completedStates.has(card.state))return false;
 return Boolean(card.finding&&card.offer&&card.contact?.email&&card.contact.state==='resolved'
  &&card.contact.boundToDraft&&card.draft?.checked);
}

function jobFor(jobs:any[],opportunityId:string){
 const mine=jobs.filter(j=>j.opportunityId===opportunityId);
 return mine.find(j=>j.status==='running')??mine.find(j=>j.status==='queued')
  ??mine.find(j=>['blocked','failed'].includes(j.status))??mine[mine.length-1]??null;
}

export function selectedRunSummary(status:any){
 const members=(status?.members??[]) as any[],jobs=(status?.jobs??[]) as any[];
 const cards:MemberCard[]=members.map(m=>{
  const parsed=Packet.safeParse(m.packet),p=parsed.success?parsed.data:null;
  const job=jobFor(jobs,m.opportunityId);
  const entry=typeof m.entryRevision==='number'?m.entryRevision:null;
  // result_revision is written by the database trigger when a job of THIS run reaches done.
  const result=typeof m.resultRevision==='number'?m.resultRevision:null;
  const current=typeof m.currentRevision==='number'?m.currentRevision:null;
  const pending=Boolean(job&&['queued','running'].includes(job.status));
  const failed=Boolean(job&&['blocked','failed'].includes(job.status));
  const superseded=result!==null&&current!==null&&current>result;
  // Nothing counts as produced until this run actually completed a stage for this member, and the
  // packet being reported is still the one it produced.
  const produced=result!==null&&!superseded&&!pending&&!failed;

  let outcome:MemberOutcome;
  if(pending)outcome='pending';
  else if(failed)outcome='failed';
  else if(terminalStates.has(m.state))outcome='held';
  else if(superseded)outcome='superseded';
  else if(!produced)outcome='reused';
  else outcome=entry!==null&&result!==null&&result>entry?'updated':'new';

  const research=p?.research??null;
  const anchored=p?draftHasAnchor(p):false;
  const facts=anchored&&research?research.claims.filter(c=>c.kind==='fact'&&c.quote.trim()):[];
  return {
   opportunityId:m.opportunityId,
   name:research?.company??p?.candidate?.providerCompany?.name??'Company',
   host:research?.accountHost??p?.candidate?.providerCompany?.domain??null,
   state:m.state,
   stage:job?.stage??m.lastCompletedStage??null,
   attempts:job?.attempts??0,
   outcome,producedInThisRun:produced,
   entryRevision:entry,resultRevision:result,currentRevision:current,
   finding:facts.length?facts[0].text:null,
   offer:research?.offer?.trim()||null,
   contact:p?.contact?{name:p.contact.name??null,role:p.contact.role??null,email:p.contact.email??null,
    state:p.contact.state,boundToDraft:Boolean(p.draft&&p.draft.recipient===p.contact.email)}:null,
   draft:p?.draft?{subject:p.draft.subject,body:p.draft.body,checked:draftIsChecked(p),
    recipient:p.draft.recipient??null}:null,
   sources:(p?.evidence??[]).filter(e=>e.origin==='original').slice(0,5)
    .map(e=>({url:e.finalUrl,title:e.title,retrievedAt:e.retrievedAt})),
   readiness:p?packetReadiness(p):null,
   blockedReason:failed?job.error??'blocked':null,
   reviewerQuestion:p?.pendingResolution?.nextAction==='ask_reviewer'&&p.pendingResolution.question
    ?{question:p.pendingResolution.question,detail:p.pendingResolution.detail,reason:p.pendingResolution.reason}:null,
  };
 });
 const counts={
  total:cards.length,
  pending:cards.filter(c=>c.outcome==='pending').length,
  produced:cards.filter(c=>c.producedInThisRun).length,
  useful:cards.filter(meetsUsefulFloor).length,
  failed:cards.filter(c=>c.outcome==='failed').length,
  held:cards.filter(c=>c.outcome==='held').length,
 };
 // An empty queue is not success. The phase states what actually happened.
 const phase=counts.pending>0?'running'
  :counts.useful>=2?'met_target'
  :counts.failed>0?'finished_with_failures'
  :'finished_below_target';
 return {run:status?.run??null,members:cards,counts,phase};
}
