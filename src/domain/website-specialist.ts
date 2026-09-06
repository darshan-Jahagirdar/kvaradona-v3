import type {Packet,Evidence,Claim} from '../contracts/pipeline';
import type {WebsiteCapture,WebsiteAnalysis} from '../contracts/website';
import {hash,hostOf} from './policy';
import {selectWebsiteFacts} from '../capture/website-facts';
export function websiteInputHash(p:Packet){return hash({research:p.research,request:p.websiteRequest,evidence:p.evidence.filter(e=>e.source!=='website_capture').map(e=>({id:e.id,version:hash(e)}))});}
export function captureEvidence(capture:WebsiteCapture):Evidence{
 const text=capture.facts.map(f=>`${f.id}: ${f.text}`).join('\n');
 return {id:capture.id,url:capture.url,finalUrl:capture.finalUrl,title:`Website capture · ${capture.accountHost}`,text,contentHash:hash(text),retrievedAt:capture.observedAt,publishedAt:null,source:'website_capture',origin:'original',status:'unknown',accountHost:capture.accountHost};
}
export function websiteContext(p:Packet){
 const s=p.websiteSupplement;if(!s)throw Error('website_capture_required');
 const selected=selectWebsiteFacts(s.capture.facts,9000).facts;
 const cited=new Set(s.analysis?.findings.flatMap(f=>f.observationIds)??[]);
 const facts=[...selected,...s.capture.facts.filter(f=>cited.has(f.id)&&!selected.some(x=>x.id===f.id))];
 const omitted=s.capture.facts.length-facts.length;
 return {profiles:s.profiles,question:s.question,url:s.capture.finalUrl,observedAt:s.capture.observedAt,renderStable:s.capture.renderStable,complete:s.capture.complete,facts,limitations:[...s.capture.limitations,...(omitted?[`${omitted} saved observations are outside this model sample. Missing observations do not establish absent content or controls.`]:[])]};
}
export function websiteReviewTarget(p:Packet){return JSON.stringify({inputHash:p.websiteSupplement?.inputHash,capture:p.websiteSupplement?.capture,analysis:p.websiteSupplement?.analysis});}
export function normalizeWebsiteScope(analysis:WebsiteAnalysis){
 const condition='If the buyer confirms this goal and need: ';
 return {...analysis,findings:analysis.findings.map(f=>({...f,proposedChange:f.proposedChange.startsWith(condition)?f.proposedChange:condition+f.proposedChange}))};
}
export function websiteAnalysisProblems(p:Packet){
 const s=p.websiteSupplement;if(!s||!s.analysis)return ['Website analysis missing'];
 const errors:string[]=[];
 if(s.inputHash!==websiteInputHash(p))errors.push('Website analysis is stale');
 if(!p.research||s.capture.accountHost!==p.research.accountHost||hostOf(s.capture.finalUrl)!==p.research.accountHost)errors.push('Website attribution mismatch');
 if(!s.capture.complete)errors.push('Website capture incomplete');
 const evidence=p.evidence.find(e=>e.id===s.capture.id),expected=captureEvidence(s.capture);
 if(!evidence||hash(evidence)!==hash(expected))errors.push('Website measurements do not match stored evidence');
 const ids=new Set<string>();
 for(const f of s.analysis.findings){
  if(!/^web[-_a-z0-9]+$/i.test(f.id)||ids.has(f.id))errors.push('Invalid or duplicate website finding ID');ids.add(f.id);
  if(!s.profiles.includes(f.profile))errors.push('Unrequested website profile');
  for(const id of f.observationIds){
   const fact=s.capture.facts.find(o=>o.id===id);
   if(!fact)errors.push(`Unknown website observation:${id}`);
   else if(fact.category==='performance')errors.push('Field performance unavailable; capture transport timing is not visitor performance');
   else if(f.profile==='cro'&&!s.capture.renderStable&&['mobile','cta','form','navigation'].includes(fact.category))errors.push('Unstable render requires verification before visual-friction claims');
  }
  if(new Set(f.observationIds).size!==f.observationIds.length)errors.push('Duplicate finding observations');
 }
 for(const profile of s.profiles){
  const coverage=s.analysis.coverage.filter(c=>c.profile===profile),hasFindings=s.analysis.findings.some(f=>f.profile===profile);
  if(coverage.length!==1||hasFindings!==(coverage[0]?.result==='findings'))errors.push(`Website coverage mismatch:${profile}`);
 }
 if(s.analysis.coverage.some(c=>!s.profiles.includes(c.profile)))errors.push('Unexpected website coverage');
 return errors;
}
export function websiteReviewProblems(p:Packet){
 const errors=websiteAnalysisProblems(p),s=p.websiteSupplement;if(!s?.analysis)return errors;
 const review=s.review;if(!review)return [...errors,'Website evidence review required'];
 if(review.inputHash!==hash(websiteReviewTarget(p)))errors.push('Website review is stale');
 if(!review.acceptable||review.issues.length)errors.push(...review.issues,'Website review requires repair');
 for(const f of s.analysis.findings){
  const verdicts=review.verdicts.filter(v=>v.findingId===f.id),v=verdicts[0];
  if(verdicts.length!==1||v.verdict!=='supported_hypothesis'||hash([...v.observationIds].sort())!==hash([...f.observationIds].sort()))errors.push(`Website review coverage:${f.id}`);
 }
 if(review.verdicts.some(v=>!s.analysis!.findings.some(f=>f.id===v.findingId)))errors.push('Unexpected website review finding');
 return errors;
}
export function websiteDraftClaims(p:Packet,available=false):Claim[]{
 const s=p.websiteSupplement;if(!s?.analysis)return [];
 const ids=new Set(s.analysis.findings.flatMap(f=>f.observationIds));
 return s.capture.facts.filter(f=>ids.has(f.id)).map(f=>({id:`web_${f.id}`,text:`During the ${s.capture.observedAt} capture: ${f.text}`,kind:'fact' as const,evidenceId:s.capture.id,quote:`${f.id}: ${f.text}`,material:true})).filter(c=>available||p.draft?.claimIds.includes(c.id));
}
