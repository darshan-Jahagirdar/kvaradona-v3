import {redirect} from 'next/navigation';
import {userClient} from '../src/persistence/server';
import {logout} from './login/actions';
import {Packet} from '../src/contracts/pipeline';
import {QualityReview} from '../components/quality-review';
import {ReviewCard} from '../components/review-card';
import {WorkflowPanel} from '../components/workflow-panel';
import {websiteReviewProblems} from '../src/domain/website-specialist';
import {crmReviewProblems} from '../src/domain/crm-specialist';
import {reviewPlacement,groupOpportunities,type ReviewSection,type ReviewItem} from '../src/domain/opportunity-review';
import {writingReviewCurrent} from '../src/domain/draft-quality';
export const dynamic='force-dynamic';
export default async function Inbox({searchParams}:{searchParams:Promise<{section?:string;filter?:string}>}){
 const params=await searchParams,section:ReviewSection=params.section==='human'?'human':params.section==='sources'?'sources':'opportunities',filter=params.filter==='rejected'?'rejected':'assessment';
 const client=await userClient();const {data:{user}}=await client.auth.getUser();if(!user)redirect('/login');
 const [opps,status,membership,observations,quality]=await Promise.all([
  client.from('opportunities').select('id,revision,packet,packet_hash,updated_at').order('updated_at',{ascending:false}).limit(500),
  client.rpc('operational_status'),client.from('memberships').select('organization_id').eq('user_id',user.id),
  client.from('discovery_observations').select('id,opportunity_id,source,external_id,observed_at,changed').order('observed_at',{ascending:false}).limit(1000),
  client.from('quality_labels').select('opportunity_id,packet_hash,labels,created_at').order('created_at',{ascending:false}).limit(1000),
 ]);
 if(membership.error)return <main className="login"><h1>Access check unavailable</h1><a href="/">Retry</a></main>;
 if(!membership.data?.length)return <main className="login"><h1>Access pending</h1><p>Your account needs membership in a review organization.</p><form action={logout}><button>Sign out</button></form></main>;
 const items=(opps.data??[]).flatMap(row=>{const parsed=Packet.safeParse(row.packet);return parsed.success&&parsed.data.mode==='live'?[{...row,packet:parsed.data}]:[];});
 const invalid=(opps.data??[]).filter(row=>!Packet.safeParse(row.packet).success);
 const buckets={opportunities:items.filter(i=>reviewPlacement(i.packet).section==='opportunities'),human:items.filter(i=>reviewPlacement(i.packet).section==='human'),sources:items.filter(i=>reviewPlacement(i.packet).section==='sources')};
 const selected=section==='human'?buckets.human.filter(i=>reviewPlacement(i.packet).rejected===(filter==='rejected')):buckets[section];
 const groups=groupOpportunities(selected),readyCount=groupOpportunities(buckets.opportunities).length;
 const labels=new Map<string,NonNullable<typeof quality.data>[number]>();for(const q of quality.data??[])if(!labels.has(q.opportunity_id))labels.set(q.opportunity_id,q);
 const metrics=status.data as {spent_usd?:string;reserved_usd?:string;limit_usd?:string}|null;
 const titles={opportunities:'Opportunity review',human:'Human review',sources:'Sources & evidence'};
 const subtitle={opportunities:'Supported opportunities and checked drafts, grouped by company. Exploratory prospects belong here too.',human:'Take a closer look at unfinished research and clear rejections. Missing evidence is not rejection.',sources:'Browse discovery material and the original evidence behind company findings.'};
 function card(item:ReviewItem){const p=item.packet,placement=reviewPlacement(p),label=labels.get(item.id);return <div id={`opportunity-${item.id}`} key={`${item.id}:${item.revision}:${item.packet_hash}`}><ReviewCard id={item.id} revision={item.revision} packet={p} needLabel={placement.need} readinessLabel={placement.readiness} writingCurrent={writingReviewCurrent(p)} discoveryObservations={(observations.data??[]).filter(o=>o.opportunity_id===item.id)} websiteChecked={Boolean(p.websiteSupplement&&!websiteReviewProblems(p).length)} crmChecked={Boolean(p.crmSupplement&&!crmReviewProblems(p).length)}/><QualityReview id={item.id} revision={item.revision} packetHash={item.packet_hash} latest={label?{labels:label.labels,current:label.packet_hash===item.packet_hash}:undefined}/></div>;}
 return <div className="workspace"><aside><div className="brand"><span className="monogram">K</span>KVARADONA <small>V3</small></div><p className="eyebrow nav-label">POC FINDINGS</p><a className={`nav ${section==='opportunities'?'active':''}`} href="/">◈ Opportunity review <span>{readyCount}</span></a><a className={`nav ${section==='human'?'active':''}`} href="/?section=human">Human review <span>{groupOpportunities(buckets.human).length+invalid.length}</span></a><a className={`nav ${section==='sources'?'active':''}`} href="/?section=sources">Sources & evidence <span>{buckets.sources.length}</span></a><a className="nav" href="/api/report">↓ POC evidence report</a><a className="nav" href="#workflow">Run workflow & status</a><div className="sidebar-bottom"><p>Research runs on your laptop.<br/>This POC ends at drafts.</p><form action={logout}><button className="text-button">Sign out</button></form></div></aside>
 <main className="inbox"><header><p className="eyebrow">RESEARCH → EVIDENCE → CHECKED DRAFT</p><div className="title-row"><div><h1>{titles[section]}</h1><p className="muted">{subtitle[section]}</p></div><span className="badge">Sending disabled</span></div></header>
 <section className="metrics"><div><span>Companies ready for review</span><strong>{readyCount}</strong></div><div><span>Recorded API cost</span><strong>{metrics?.spent_usd!==undefined?'$'+metrics.spent_usd:'Unknown'}</strong></div><div><span>Reserved / unresolved</span><strong>{metrics?.reserved_usd!==undefined?'$'+metrics.reserved_usd:'Unknown'}</strong></div><div><span>Cumulative budget cap</span><strong>{metrics?.limit_usd?'$'+metrics.limit_usd:'Unknown'}</strong></div></section>
 <div id="workflow"><WorkflowPanel organizationId={membership.data[0].organization_id}/></div>
 {(opps.error||status.error||observations.error||quality.error)&&<p role="alert" className="error">Some records could not be loaded. Counts and lists may be incomplete.</p>}
 {opps.data?.length===500&&<p className="error">Showing the latest 500 records. Export the report for the wider batch.</p>}
 {section==='human'&&<nav className="filters" aria-label="Human review filters"><a aria-current={filter==='assessment'?'page':undefined} href="/?section=human">Needs assessment ({buckets.human.filter(i=>!reviewPlacement(i.packet).rejected).length+invalid.length})</a><a aria-current={filter==='rejected'?'page':undefined} href="/?section=human&filter=rejected">Rejected ({buckets.human.filter(i=>reviewPlacement(i.packet).rejected).length})</a></nav>}
 {section!=='sources'&&groups.map(group=><section className="company-group" key={group.key}><div className="section-line"><h2>{group.name}</h2><span>{group.items.length} {group.items.length===1?'opportunity':'opportunities'} · evidence stays with each finding</span></div>{group.items.map(card)}</section>)}
 {section==='human'&&filter==='assessment'&&invalid.map(row=><section className="card workflow" key={row.id}><h2>Record needs investigation</h2><p>The saved packet cannot be read with the current schema. It has been preserved.</p></section>)}
 {section==='sources'&&<><h2>Unassigned discovery sources</h2><p className="muted">These are research material, not qualified leads. Identifiable companies move into Human review or Opportunity review.</p>{selected.map(item=><details className="source-card" key={item.id}><summary>{item.packet.candidate?.title??'Unattributed source'}</summary><p>{item.packet.candidate?.description}</p>{item.packet.candidate&&<a href={item.packet.candidate.url} target="_blank" rel="noreferrer">Original source ↗</a>}<p className="footnote">{item.packet.state.replaceAll('_',' ')} · Company attribution pending</p>{card(item)}</details>)}<h2 className="evidence-heading">Evidence linked to companies</h2>{items.filter(i=>reviewPlacement(i.packet).identity).map(item=>{const placement=reviewPlacement(item.packet);return <section className="source-card" key={item.id}><h3>{placement.identity!.name}</h3><a href={`/?section=${placement.section}${placement.rejected?'&filter=rejected':''}#opportunity-${item.id}`}>Open company findings →</a>{item.packet.evidence.map(e=><details key={e.id}><summary>{e.title}</summary><a href={e.finalUrl} target="_blank" rel="noreferrer">Original source ↗</a><p className="footnote">{e.origin} · {e.status} · Retrieved {e.retrievedAt}</p><blockquote>{e.text.slice(0,3000)}</blockquote></details>)}</section>;})}</>}
 {!selected.length&&<section className="empty"><h2>{section==='opportunities'?'No checked company opportunities yet.':'Nothing in this view yet.'}</h2><p>Unfinished research and source material remain available in their own sections.</p></section>}
 <footer>Evidence supports a conversation. A checked draft does not establish buying intent or guarantee a reply.</footer></main></div>;
}
