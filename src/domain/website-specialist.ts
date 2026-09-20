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
 return {...analysis,findings:analysis.findings.map(f=>({...f,id:/^web[-_a-z0-9]+$/i.test(f.id)?f.id:/^[a-z][-_a-z0-9]{0,79}$/i.test(f.id)?`web_${f.id}`:f.id,proposedChange:f.proposedChange.startsWith(condition)?f.proposedChange:condition+f.proposedChange}))};
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

/** Words that mark the page where a visitor acts, grouped by the angle the research proposes.
 *  These describe the JOURNEY, not any particular company, so no account is special-cased. */
const journeyIntent:Record<string,RegExp>={
 cro:/\b(request a demo|book a demo|get a demo|demo|free trial|start (?:free|now)|get started|contact sales|talk to (?:us|sales)|pricing|quote|make an appointment|request an appointment|book (?:an )?appointment|schedule|find a (?:provider|doctor|physician)|apply|enrol|enroll|register|sign up)\b/i,
 aeo:/\b(services|solutions|products|what we do|how it works|about)\b/i,
};
const stop=new Set(['the','a','an','and','or','of','for','to','in','on','with','its','their','our','is','are','be','this','that','from','by','at','as','we','you','how','what','page','pages','site','website','visitor','visitors','user','users']);
/** A crude stem so "requesting" and "request", "appointments" and "appointment" compare equal. */
const stem=(w:string)=>w.replace(/(ing|ed|es|s)$/,'');
/** Terms the research itself used, so the chosen page answers THIS question rather than merely
 *  being the highest-scoring call to action on the site. */
function questionTerms(question:string){
 return new Set(question.toLowerCase().split(/[^a-z]+/).filter(w=>w.length>3&&!stop.has(w)).map(stem));
}

/** The journey page the company's OWN capture points at, relevant to the research question.
 *  Chosen from recorded navigation, never guessed from a name, always on the account's own host. */
export function journeyTarget(capture:WebsiteCapture,accountHost:string,profiles:readonly string[],question:string):{url:string;label:string;why:string}|null{
 const pattern=profiles.map(p=>journeyIntent[p]).find(Boolean);if(!pattern)return null;
 const terms=questionTerms(question||'');
 const current=new URL(capture.finalUrl);
 const owned=(host:string)=>host===accountHost||host.endsWith('.'+accountHost);
 let best:{url:string;label:string;why:string;score:number}|null=null;
 for(const fact of capture.facts){
  if(fact.category!=='cta'&&fact.category!=='navigation')continue;
  let parsed:{label?:unknown;href?:unknown};
  try{parsed=JSON.parse(fact.text);}catch{continue;}
  const label=typeof parsed.label==='string'?parsed.label.trim():'';
  const href=typeof parsed.href==='string'?parsed.href.trim():'';
  if(!label||!href)continue;
  let target:URL;try{target=new URL(href,current);}catch{continue;}
  if(target.protocol!=='https:'||!owned(target.hostname.replace(/^www\./,'')))continue;
  if(target.href===current.href||target.pathname==='/')continue;
  const words=(label+' '+target.pathname).toLowerCase().split(/[^a-z]+/).filter(Boolean).map(stem);
  const matched=[...new Set(words.filter(w=>terms.has(w)))];
  const intent=(pattern.test(label)?10:0)+(pattern.test(target.pathname.replace(/[-_/]+/g,' '))?6:0);
  if(!intent)continue;
  // Intent decides WHETHER a link is a journey step at all. Agreement with the research question
  // then decides WHICH one, so an unrelated pricing link cannot displace the page actually asked
  // about merely by scoring well on generic call-to-action wording.
  const score=matched.length*25+intent+(fact.category==='cta'?3:0);
  const why=matched.length?`matches the research question on ${matched.slice(0,3).join(', ')}`:'the relevant next step in the visitor journey';
  if(!best||score>best.score)best={url:target.href,label,why,score};
 }
 return best?{url:best.url,label:best.label,why:best.why}:null;
}
