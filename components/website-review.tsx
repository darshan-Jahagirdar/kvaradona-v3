import type {Packet} from '../src/contracts/pipeline';
import {displayDate} from '../src/domain/display-date';
export function WebsiteReviewPanel({id,packet,checked}:{id:string;packet:Packet;checked:boolean}){
 const s=packet.websiteSupplement;if(!s)return null;
 return <section><h3>Website analysis · {s.profiles.map(p=>p.toUpperCase()).join(' / ')}</h3>
  <p className="footnote">{s.capture.mode==='live'?'Live public-page capture':'Synthetic page fixture'} · {displayDate(s.capture.observedAt,true)} · Evidence review: {checked?'checked':'pending or repair needed'}</p>
  {s.capture.mode==='fixture'&&<p className="footnote">Synthetic verification only. Analysis and review are mocked; no live model result or prospect qualification.</p>}
  <p>{s.question}</p><a href={s.capture.finalUrl} target="_blank" rel="noreferrer">Captured page ↗</a>
  {!s.capture.complete&&<p role="status">Capture incomplete. Missing content is not a verified site problem.</p>}
  {s.analysis?.coverage.map(c=><p key={c.profile}><strong>{c.profile.toUpperCase()} · {c.result.replaceAll('_',' ')}</strong><br/>{c.reason}</p>)}
  {s.analysis?.findings.map(f=><details key={f.id}><summary>{f.profile.toUpperCase()} · {f.hypothesis}</summary>
   <p className="footnote">Hypothesis to validate; no measured conversion or visibility impact.</p>
   {f.observationIds.map(oid=>{const observation=s.capture.facts.find(o=>o.id===oid);return observation?<blockquote key={oid}>{observation.text}<br/><span className="footnote">{observation.viewport}{observation.selector?` · ${observation.selector}`:''}</span></blockquote>:<p key={oid}>Observation unavailable.</p>;})}
   <p><strong>Validate:</strong> {f.validationQuestion}</p><p><strong>Possible change:</strong> {f.proposedChange}</p>
  </details>)}
  {!checked&&s.review?.issues.length? <ul>{s.review.issues.map((issue,i)=><li key={i}>{issue}</li>)}</ul>:null}
  <details><summary>Capture evidence · {s.capture.screenshots.length} screenshots</summary>{s.capture.screenshots.map(image=><figure key={image.viewport}><figcaption>{image.viewport} · {image.width} × {image.height}</figcaption><img src={`/api/website-artifact?opportunity=${encodeURIComponent(id)}&viewport=${image.viewport}`} alt={`${image.viewport} capture of ${s.capture.accountHost}`} width={image.width} height={image.height} loading="lazy" style={{maxWidth:'100%',height:'auto'}}/></figure>)}</details>
  <details><summary>Coverage and limitations</summary><ul>{[...s.capture.limitations,...(s.analysis?.limitations??[])].map((l,i)=><li key={i}>{l}</li>)}</ul><p className="footnote">Capture: {s.capture.requests} requests · {s.capture.bytes} bytes · {Math.round(s.capture.elapsedMs)} ms. These are collection costs, not visitor performance scores.</p></details>
 </section>;
}
