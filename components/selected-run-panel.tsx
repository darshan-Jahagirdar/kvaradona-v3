'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {stageNames} from '../src/domain/workflow-status';
import type {MemberCard} from '../src/domain/selected-run';

type Company={campaign_id:string;campaign_name:string;opportunity_id:string;name:string;host:string|null;state:string;selectable:boolean};
type RunView={run:{id:string;created_at:string;mode:string;expires_at:string|null;status:string}|null;
 members:MemberCard[];
 counts:{total:number;pending:number;produced:number;useful:number;failed:number;held:number};
 phase:'running'|'met_target'|'finished_with_failures'|'finished_below_target'};

const phaseLabel:Record<string,string>={running:'Running',met_target:'Finished — target met',
 finished_with_failures:'Finished — some companies need attention',finished_below_target:'Finished below target'};

/** Run and request identity survive a reload, and a changed selection deliberately mints a new
 *  request key so a different cohort is never folded into the previous idempotent request. */
type Saved={requestKey:string;runId:string|null;selection:string;campaignId:string|null};
// Scoped per organization so a different tenant's run is never resumed in this browser.
const storeKey=(organizationId:string)=>`kvd.selectedRun.v1.${organizationId}`;
function loadSaved(organizationId:string):Saved|null{try{const raw=localStorage.getItem(storeKey(organizationId));return raw?JSON.parse(raw) as Saved:null;}catch{return null;}}
function saveState(organizationId:string,v:Saved|null){try{v?localStorage.setItem(storeKey(organizationId),JSON.stringify(v)):localStorage.removeItem(storeKey(organizationId));}catch{}}
const selectionKey=(ids:Iterable<string>)=>[...ids].sort().join(',');

const outcomeLabel:Record<string,string>={new:'Produced in this run',updated:'Updated in this run',reused:'Reused earlier result',pending:'Working',held:'Held',failed:'Needs attention'};

export function SelectedRunPanel({organizationId}:{organizationId:string}){
 const [companies,setCompanies]=useState<Company[]>([]);
 const [chosen,setChosen]=useState<Set<string>>(new Set());
 const [runId,setRunId]=useState<string|null>(null);
 const [view,setView]=useState<RunView|null>(null);
 const [worker,setWorker]=useState<{online?:boolean}|null>(null);
 const [message,setMessage]=useState('');
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);
 const flight=useRef(false),router=useRouter();
 const [saved,setSaved]=useState<Saved|null>(null);
 const [restored,setRestored]=useState(false);

 const load=useCallback(async(id:string|null)=>{
  try{
   const url=`/api/selected-workflow?organizationId=${organizationId}${id?`&runId=${id}`:''}`;
   const r=await fetch(url,{cache:'no-store'});
   if(!r.ok)throw Error('unavailable');
   const data=await r.json();
   setCompanies(data.companies??[]);setWorker(data.worker??null);
   if(data.run)setView(data.run);
   setError('');
  }catch{setError('Selected-run status is unavailable. The last displayed status may be stale.');}
 },[organizationId]);

 useEffect(()=>{const s=loadSaved(organizationId);if(s){setSaved(s);if(s.runId)setRunId(s.runId);}setRestored(true);},[organizationId]);
 useEffect(()=>{if(!restored)return;void load(runId);const t=setInterval(()=>{if(document.visibilityState==='visible')void load(runId);},6000);return()=>clearInterval(t);},[load,runId,restored]);

 // Preselect the accepted cohort's companies: every selectable account in the first campaign shown.
 useEffect(()=>{if(!restored||chosen.size||!companies.length)return;
  if(saved?.selection){setChosen(new Set(saved.selection.split(',').filter(Boolean)));return;}
  // Nothing is preselected across campaigns: the reviewer chooses the cohort deliberately.
 },[companies,chosen.size,restored,saved]);

 const chosenCampaigns=[...new Set(companies.filter(c=>chosen.has(c.opportunity_id)).map(c=>c.campaign_id))];
 const campaignId=chosenCampaigns[0]??null;

 async function run(){
  if(flight.current||!chosen.size)return;
  flight.current=true;setBusy(true);setMessage('');
  const selection=selectionKey(chosen);
  // A repeat click reuses the stored key and resolves to the same run. A changed selection is a
  // different request, so it gets its own key rather than silently reusing the previous run.
  const key=saved&&saved.selection===selection&&saved.campaignId===campaignId?saved.requestKey:crypto.randomUUID();
  // The exact request is persisted BEFORE sending. If the response is lost or the page reloads
  // mid-flight, the next click replays the same key and resolves to the same run instead of
  // launching a second paid one.
  const intent:Saved={requestKey:key,runId:saved?.requestKey===key?saved.runId??null:null,selection,campaignId};
  setSaved(intent);saveState(organizationId,intent);
  try{
   const r=await fetch('/api/selected-workflow',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({organizationId,opportunityIds:[...chosen],requestKey:key})});
   const data=await r.json();
   if(!r.ok)throw Error(data.error??'Could not start the run');
   const next:Saved={requestKey:key,runId:data.runId as string,selection,campaignId};
   setSaved(next);saveState(organizationId,next);setRunId(data.runId);
   setMessage(data.created?`Queued ${data.queued} ${data.queued===1?'company':'companies'}. Progress updates automatically.`
    :'That request already started a run; showing its progress.');
   await load(data.runId);router.refresh();
  }catch(e){setMessage(e instanceof Error?e.message:'Request outcome unknown. Retry safely with the same request.');}
  finally{flight.current=false;setBusy(false);}
 }

 const counts=view?.counts;
 const active=view?.phase==='running';
 function startNew(){setSaved(null);saveState(organizationId,null);setRunId(null);setView(null);setMessage('Cleared. Selecting companies and clicking Run workflow starts a new run.');}
 return <section className="workflow card" aria-label="Selected company workflow">
  <div className="title-row"><div><h2>Run workflow — selected companies</h2>
   <p className="muted">Chosen accounts, not discovery. Explorium intent, trial dates and the discovery cursor are not consulted.</p></div>
   <div><button onClick={run} disabled={busy||!chosen.size||active}>{busy?'Queuing…':'Run workflow'}</button>
   {view?.run&&!active&&<button className="text-button" onClick={startNew}>Start a new run</button>}</div></div>

  <p aria-live="polite"><strong>{view?.phase?phaseLabel[view.phase]:'Ready'}</strong> · {worker?.online?'Laptop worker online':'Laptop worker offline'}
   {active&&!worker?.online?' — start the local worker to continue.':''}
   {view?.run?.expires_at&&active?` · run window ends ${new Date(view.run.expires_at).toLocaleTimeString()}`:''}</p>
  {chosenCampaigns.length>1&&<p className="footnote">These companies come from {chosenCampaigns.length} source campaigns. One run covers them all; each keeps its own campaign.</p>}
  {message&&<p role="status">{message}</p>}
  {error&&<p role="alert" className="error">{error}</p>}

  <details open={!view?.run}><summary>Companies ({chosen.size} selected)</summary>
   {companies.map(c=><label key={c.opportunity_id} className="workflow-step" data-opportunity={c.opportunity_id}>
    <input type="checkbox" value={c.opportunity_id} name="company"
     checked={chosen.has(c.opportunity_id)} disabled={!c.selectable||active}
     onChange={e=>{const next=new Set(chosen);e.target.checked?next.add(c.opportunity_id):next.delete(c.opportunity_id);setChosen(next);}}/>
    <span>{c.name}</span>
    {/* Several saved records share a name or have none at all, so the record's own identifier is
        shown. Choosing the wrong row would silently substitute one company for another. */}
    <span className="footnote">{c.host??'host unknown'} · {c.state.replaceAll('_',' ')}
     {c.selectable?'':' · excluded'} · <code>{c.opportunity_id.slice(0,8)}</code></span>
   </label>)}
  </details>

  {view?.run&&counts&&<>
   <p>{counts.total} in this run · {counts.produced} produced by this run · {counts.useful} meet the technical floor · {counts.pending} working · {counts.failed} need attention{counts.held?` · ${counts.held} held`:''}</p>
   <p className="footnote">The technical floor means a supported fact, an offer, a resolved contact bound to the draft, and both draft checks current for this exact text. It is not a judgement of commercial quality.</p>
   {view.members.map(m=><article className="workflow-step" key={m.opportunityId}>
    <strong>{m.name}</strong> <span>{outcomeLabel[m.outcome]??m.outcome}</span>
    <p className="footnote">{m.stage?`${stageNames[m.stage]??m.stage} · `:''}{m.state.replaceAll('_',' ')}
     {m.attempts>1?` · attempt ${m.attempts}`:''}{m.producedInThisRun?'':' · earlier result'}</p>
    {m.finding&&<p><strong>Finding:</strong> {m.finding}</p>}
    {m.offer&&<p><strong>Offer:</strong> {m.offer}</p>}
    {m.contact&&<p><strong>Contact:</strong> {m.contact.name??'unresolved'}{m.contact.role?` — ${m.contact.role}`:''}{m.contact.email?` · ${m.contact.email}`:''}
     {m.contact.state==='resolved'&&<span className="footnote"> · provider-reported current work email; functional fit inferred from title</span>}</p>}
    {m.draft&&<details><summary><strong>Draft:</strong> {m.draft.subject} · {m.draft.checked?'checked':'not currently checked'}{m.draft.recipient?` · to ${m.draft.recipient}`:''}</summary>
     <p className="footnote">Revision {m.resultRevision??m.currentRevision??'unknown'}{m.producedInThisRun?' produced by this run':' from an earlier run'}</p>
     <pre className="draft-body">{m.draft.body}</pre></details>}
    {m.sources.length>0&&<p className="footnote">Sources: {m.sources.map(s=><a key={s.url} href={s.url} target="_blank" rel="noreferrer">{s.title||s.url} ↗ </a>)}</p>}
    {m.blockedReason&&<p className="error">Needs attention: {m.blockedReason}</p>}
    {m.reviewerQuestion&&<div className="error" role="status">
     <p><strong>One question blocks this company:</strong> {m.reviewerQuestion.question}</p>
     <p className="footnote">{m.reviewerQuestion.detail} Automatic resolution is exhausted. Answer it
      on the company&apos;s card using <em>Send back for research</em>; your note becomes the question
      the next stage works from.</p></div>}
   </article>)}
   <p className="footnote">A finished step is not a finished lead. Results produced by this run are separated from reused earlier results. Sending stays disabled.</p>
  </>}
 </section>;
}
