/** Exact user-approved target. Topic/industry IDs are intentionally unresolved. */
export const intentIcp={
 version:9,employeeRange:{min:500,max:10000},
 countries:[{code:'IN',name:'India'},{code:'US',name:'United States'},{code:'GB',name:'United Kingdom'},{code:'AU',name:'Australia'},{code:'NZ',name:'New Zealand'},{code:'AE',name:'United Arab Emirates'},{code:'SG',name:'Singapore'}],
 buyerTitles:['CMO','VP Marketing','VP Sales','CEO','Operations','Sales Manager','Sales Head'],
 industries:['IT & Services','Construction','Marketing & Advertising','Real Estate','Healthcare','Consulting','Software','Consumer Services','Automotive','Education','Design','Hospitality'],
 intentTopics:['HubSpot','Monday.com','SEO','Website','CRM','Marketing Automation'],
};
export const intentSetup={ready:true,code:'intent_source_verified',reason:'Explorium/Bombora trial discovery and dated intent enrichment verified. Active pilot: Pardot.'} as const;
export const intentWorkflowProfile={version:9,name:'Pardot intent · full ICP',sendingEnabled:false,maxResearch:3,maxCandidates:5,icp:intentIcp,activeIntentTopics:['media & advertising: pardot'],discoverySetup:intentSetup,groups:[{source:'explorium',region:'unspecified',country:'US',language:'en',page:1,query:''}]};
/** Apollo company-only discovery stays disabled; verified intent has its own source. */
export function requireIntentDiscovery(){throw new Error('apollo_intent_access_unverified');}
