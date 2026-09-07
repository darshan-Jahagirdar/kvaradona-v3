export const stageNames:Record<string,string>={S02:'Discovering companies / sources',S04:'Assessing ICP and researching original context',S06:'Researching the company and need',S06R:'Checking source attribution',S08:'Analyzing relevant CRM / website findings',S09:'Checking the evidence and offer',S10:'Finding the right contact',S11:'Writing and checking the draft'};
export type WorkflowStatus={companyCount?:number;run?:{id:string;created_at:string};worker:{online:boolean;seenAt:string|null};budget:{live_enabled?:boolean;spent_usd?:string;reserved_usd?:string;limit_usd?:string};jobs:{id:string;opportunity_id:string|null;stage:string;status:string;error:string|null}[];opportunities:{id:string;state:string;name:string}[]};
export function workflowSummary(s:WorkflowStatus){
 const running=s.jobs.filter(j=>j.status==='running'),queued=s.jobs.filter(j=>j.status==='queued'),failed=s.jobs.filter(j=>['blocked','failed'].includes(j.status));
 const budgetPaused=s.budget.live_enabled===false||failed.some(j=>/budget|quota/.test(j.error??''));
 const phase=!s.run?'Ready to start':!s.worker.online&&(running.length||queued.length)?'Waiting for laptop worker':running.length?'Running':queued.length?'Queued':budgetPaused?'Paused by budget':failed.length?'Finished with issues':'Finished';
 return {phase,active:Boolean(running.length||queued.length),running,queued,failed,finished:s.jobs.filter(j=>j.status==='done').length};
}
export function failureMessage(reason:string|null){
 if(/budget/.test(reason??''))return 'Budget limit reached. Completed work and unresolved reservations are preserved.';
 if(/provider_unverified/.test(reason??''))return 'Provider authorization expired or is unavailable. No automatic retry.';
 if(/ambiguous|uncertain/.test(reason??''))return 'Provider outcome is uncertain. Its reservation stays held; no automatic retry.';
 if(/quota/.test(reason??''))return 'Verified provider allowance is unavailable or exhausted.';
 return reason?.replaceAll('_',' ')??'This step needs investigation. Saved evidence remains available.';
}
