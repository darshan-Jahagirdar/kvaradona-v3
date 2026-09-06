import { redirect } from 'next/navigation';
import { userClient } from '../src/persistence/server';
import { logout } from './login/actions';
import { Packet } from '../src/contracts/pipeline';
import { ReviewCard } from '../components/review-card';
export const dynamic='force-dynamic';
export default async function Inbox(){
 const client=await userClient();const {data:{user}}=await client.auth.getUser();if(!user) redirect('/login');
 const [opps,jobs,status,membership]=await Promise.all([
  client.from('opportunities').select('id,revision,state,packet,updated_at').order('updated_at',{ascending:false}).limit(40),
  client.from('jobs').select('id,stage,status,error,created_at').order('created_at',{ascending:false}).limit(12),
  client.rpc('operational_status'),client.from('memberships').select('organization_id').eq('user_id',user.id),
 ]);
 if(membership.error||!membership.data?.length) return <main className="login"><h1>Access pending</h1><p>Your account needs membership in a review organization.</p><form action={logout}><button>Sign out</button></form></main>;
 const items=(opps.data??[]).map(row=>({...row,parsed:Packet.safeParse(row.packet)}));
 const metrics=status.data as {spent_usd?:string;reserved_usd?:string;limit_usd?:string;worker_seen_at?:string;live_enabled?:boolean}|null;
 const active=metrics?.worker_seen_at&&Date.now()-Date.parse(metrics.worker_seen_at)<120000;
 return <div className="workspace"><aside><div className="brand"><span className="monogram">K</span>KVARADONA <small>V3</small></div><p className="eyebrow nav-label">WORKSPACE</p><a className="nav active" href="/">◈ &nbsp; Opportunity review <span>{items.length}</span></a><a className="nav" href="#activity">◷ &nbsp; Recent activity</a><div className="sidebar-bottom"><span className={`dot ${active?'online':''}`}/>{active?'Worker connected':'Worker idle'}<p>Research runs on your laptop.</p><form action={logout}><button className="text-button">Sign out</button></form></div></aside>
 <main className="inbox"><header><p className="eyebrow">RESEARCH → REVIEW → CONVERSATION</p><div className="title-row"><div><h1>Opportunity review</h1><p className="muted">A useful offer. A clear reason. Every claim traceable.</p></div><span className="badge">Sending disabled</span></div></header>
 <section className="metrics"><div><span>Review queue</span><strong>{items.length}</strong></div><div><span>Recorded API cost</span><strong>{metrics?.spent_usd!==undefined?'$'+metrics.spent_usd:'Unknown'}</strong></div><div><span>Reserved / unresolved</span><strong>{metrics?.reserved_usd!==undefined?'$'+metrics.reserved_usd:'Unknown'}</strong></div><div><span>Initial budget cap</span><strong>{metrics?.limit_usd?'$'+metrics.limit_usd:'Unknown'}</strong></div></section>
 {(opps.error||jobs.error||status.error)&&<p role="alert" className="error">Some records could not be loaded. The displayed list may be incomplete.</p>}
 <div className="section-line"><h2>Research queue</h2><span>Strong evidence first · room for exploration</span></div>
 {!items.length&&<section className="empty"><span>◈</span><h2>Your first opportunity starts here.</h2><p>Run a bounded discovery campaign from the local worker. Its research, evidence and checked draft will appear here.</p></section>}
 {items.map(item=>item.parsed.success?<ReviewCard key={`${item.id}:${item.revision}`} id={item.id} revision={item.revision} packet={item.parsed.data}/>:<section className="card" key={item.id}><h2>Record needs investigation</h2><p>The saved packet does not match the current schema. No approval is available.</p></section>)}
 <section id="activity" className="activity"><h2>Recent activity</h2>{(jobs.data??[]).map(job=><div key={job.id}><span className="stage">{job.stage}</span><span>{job.status}</span><span className="muted">{job.error??'—'}</span></div>)}{!jobs.data?.length&&<p className="muted">No work has been queued yet.</p>}</section>
 <footer>Evidence can support a conversation. It does not establish buying intent or guarantee a reply.</footer></main></div>;
}
