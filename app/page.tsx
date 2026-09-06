import { redirect } from 'next/navigation';
import { userClient } from '../src/persistence/server';
import { logout } from './login/actions';
import { Packet } from '../src/contracts/pipeline';
import {QualityReview} from '../components/quality-review';
import { ReviewCard } from '../components/review-card';
import {websiteReviewProblems} from '../src/domain/website-specialist';
import {crmReviewProblems} from '../src/domain/crm-specialist';
export const dynamic='force-dynamic';
export default async function Inbox(){
 const client=await userClient();const {data:{user}}=await client.auth.getUser();if(!user) redirect('/login');
 const [opps,jobs,status,membership,observations,quality]=await Promise.all([
  client.from('opportunities').select('id,revision,state,packet,packet_hash,updated_at').order('updated_at',{ascending:false}).limit(40),
  client.from('jobs').select('id,stage,status,error,created_at').order('created_at',{ascending:false}).limit(12),
  client.rpc('operational_status'),client.from('memberships').select('organization_id').eq('user_id',user.id),
  client.from('discovery_observations').select('id,opportunity_id,source,external_id,observed_at,changed').order('observed_at',{ascending:false}).limit(200),
  client.from('quality_labels').select('opportunity_id,packet_hash,labels,created_at').order('created_at',{ascending:false}).limit(200),
 ]);
 if(membership.error)return <main className="login"><h1>Access check unavailable</h1><p>Your access could not be checked. Try loading the page again.</p><a href="/">Retry</a></main>;
 if(!membership.data?.length) return <main className="login"><h1>Access pending</h1><p>Your account needs membership in a review organization.</p><form action={logout}><button>Sign out</button></form></main>;
 const items=(opps.data??[]).map(row=>({...row,parsed:Packet.safeParse(row.packet)}));
 const qualityByOpportunity=new Map<string,NonNullable<typeof quality.data>[number]>();for(const q of quality.data??[])if(!qualityByOpportunity.has(q.opportunity_id))qualityByOpportunity.set(q.opportunity_id,q);
 const metrics=status.data as {spent_usd?:string;reserved_usd?:string;limit_usd?:string;worker_seen_at?:string;live_enabled?:boolean}|null;
 const active=metrics?.worker_seen_at&&Date.now()-Date.parse(metrics.worker_seen_at)<120000;
 return <div className="workspace"><aside><div className="brand"><span className="monogram">K</span>KVARADONA <small>V3</small></div><p className="eyebrow nav-label">WORKSPACE</p><a className="nav active" href="/">◈ &nbsp; Opportunity review <span>{items.length}</span></a><a className="nav" href="/api/report">↓ &nbsp; POC evidence report</a><a className="nav" href="#activity">◷ &nbsp; Recent activity</a><div className="sidebar-bottom"><span className={`dot ${active?'online':''}`}/>{active?'Worker connected':'Worker idle'}<p>Research runs on your laptop.</p><form action={logout}><button className="text-button">Sign out</button></form></div></aside>
 <main className="inbox"><header><p className="eyebrow">RESEARCH → REVIEW → CONVERSATION</p><div className="title-row"><div><h1>Opportunity review</h1><p className="muted">A useful offer. A clear reason. Every claim traceable.</p></div><span className="badge">Sending disabled</span></div></header>
 <section className="metrics"><div><span>Review queue</span><strong>{items.length}</strong></div><div><span>Recorded API cost</span><strong>{metrics?.spent_usd!==undefined?'$'+metrics.spent_usd:'Unknown'}</strong></div><div><span>Reserved / unresolved</span><strong>{metrics?.reserved_usd!==undefined?'$'+metrics.reserved_usd:'Unknown'}</strong></div><div><span>Initial budget cap</span><strong>{metrics?.limit_usd?'$'+metrics.limit_usd:'Unknown'}</strong></div></section>
 {(opps.error||jobs.error||status.error||observations.error||quality.error)&&<p role="alert" className="error">Some records could not be loaded. The displayed list may be incomplete.</p>}
 <div className="section-line"><h2>Research queue</h2><span>Strong evidence first · room for exploration</span></div>
 {!items.length&&<section className="empty"><span>◈</span><h2>Your first opportunity starts here.</h2><p>Run a bounded discovery campaign from the local worker. Its research, evidence and checked draft will appear here.</p></section>}
 {items.map(item=>item.parsed.success?<div key={`${item.id}:${item.revision}`}><ReviewCard id={item.id} revision={item.revision} packet={item.parsed.data} discoveryObservations={(observations.data??[]).filter(o=>o.opportunity_id===item.id)} websiteChecked={Boolean(item.parsed.data.websiteSupplement&&!websiteReviewProblems(item.parsed.data).length)} crmChecked={Boolean(item.parsed.data.crmSupplement&&!crmReviewProblems(item.parsed.data).length)}/><QualityReview id={item.id} revision={item.revision} packetHash={item.packet_hash} latest={qualityByOpportunity.has(item.id)?{labels:qualityByOpportunity.get(item.id)!.labels,current:qualityByOpportunity.get(item.id)!.packet_hash===item.packet_hash}:undefined}/></div>:<section className="card" key={item.id}><h2>Record needs investigation</h2><p>The saved packet does not match the current schema. No approval is available.</p></section>)}
 <section id="activity" className="activity"><h2>Recent activity</h2>{(jobs.data??[]).map(job=><div key={job.id}><span className="stage">{job.stage}</span><span>{job.status}</span><span className="muted">{job.error??'—'}</span></div>)}{!jobs.data?.length&&<p className="muted">No work has been queued yet.</p>}</section>
 <footer>Evidence can support a conversation. It does not establish buying intent or guarantee a reply.</footer></main></div>;
}
