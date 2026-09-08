import type {ProviderCompany} from '../contracts/discovery';

// Exact strings from the saved Bombora catalogue. Families are business concepts, not extra signals.
export const intentTopicProfiles=[
 {id:'hubspot',name:'HubSpot',topics:['media & advertising: hubspot (hubs)','media & advertising: hubspot marketing hub'],terms:['HubSpot','marketing hub'],query:'"HubSpot" (implementation OR migration OR integration)',offer:'A scoped HubSpot setup, migration or integration assessment with a practical implementation outline.'},
 {id:'monday',name:'Monday.com',topics:['technology: monday.com'],terms:['monday.com','monday work management'],query:'"monday.com" (workflow OR integration OR rollout)',offer:'A scoped review of project handoffs and monday.com workflows, with a small proposed automation or integration.'},
 {id:'seo',name:'SEO',topics:['search marketing: search engine optimization (seo)'],terms:['SEO','search engine optimization','organic search'],query:'(SEO OR "organic search") (initiative OR hiring OR international OR strategy)',offer:'A scoped search/content assessment with an evidence-based list of opportunities to validate; no promised ranking or traffic gain.'},
 {id:'website',name:'Website',topics:['business solutions: corporate website','website publishing: website design','web: replatform website','it management: website performance'],terms:['website','web design','replatform','site redesign','web development'],query:'(website OR replatform OR "web development") (project OR redesign OR launch OR performance)',offer:'A scoped website journey, design, development or platform assessment tied to the observed initiative; test suspected friction before proposing fixes.'},
 {id:'crm',name:'CRM',topics:['crm: customer relationship management (crm)'],terms:['CRM','customer relationship management','lead routing','sales operations'],query:'(CRM OR "customer relationship management") (migration OR consolidation OR integration OR implementation)',offer:'A scoped review of CRM data, handoffs or integration requirements, followed by a practical implementation outline.'},
 {id:'marketing_automation',name:'Marketing Automation',topics:['crm: marketing automation'],terms:['marketing automation','lifecycle marketing','campaign operations','marketing operations','lead nurturing'],query:'("marketing automation" OR "lifecycle marketing") (workflow OR integration OR programme OR hiring)',offer:'A scoped assessment of lifecycle/campaign workflows and integrations, with one useful automation deliverable conditional on confirmed need.'},
] as const;
export const activeIntentTopics:string[]=intentTopicProfiles.flatMap(p=>[...p.topics]);
export const topicProfile=(topic:string)=>intentTopicProfiles.find(p=>(p.topics as readonly string[]).includes(topic));
export function matchedTopicProfiles(c:ProviderCompany){
 const signals=c.intent.topics??[];
 return intentTopicProfiles.filter(p=>signals.some(s=>(p.topics as readonly string[]).includes(s.topic)))
  .sort((a,b)=>Math.max(...signals.filter(s=>(b.topics as readonly string[]).includes(s.topic)).map(s=>s.score))-Math.max(...signals.filter(s=>(a.topics as readonly string[]).includes(s.topic)).map(s=>s.score)));
}
export function topicResearchPlan(c:ProviderCompany){
 const profiles=matchedTopicProfiles(c);
 return {families:profiles.map(p=>p.name),primaryFamily:profiles[0]?.name??null,offers:profiles.map(p=>({family:p.name,offer:p.offer})),instruction:'Provider topic research guides investigation; it does not prove an installed tool, a project, pain, budget, timing or demand for outside help. Extract dated original facts, assess contrary evidence, then choose one supported service hypothesis and useful offer. Missing public corroboration may remain exploration, not automatic rejection. Do not count overlapping topics as independent evidence.'};
}
export function topicRelevance(text:string,c:ProviderCompany){
 const lower=text.toLowerCase();
 return matchedTopicProfiles(c).filter(p=>p.terms.some(t=>new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'i').test(lower))).length;
}
