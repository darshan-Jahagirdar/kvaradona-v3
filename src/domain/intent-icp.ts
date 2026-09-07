/** Exact user-approved target. Topic/industry IDs are intentionally unresolved. */
export const intentIcp={
 version:8,employeeRange:{min:500,max:10000},
 countries:[{code:'IN',name:'India'},{code:'US',name:'United States'},{code:'GB',name:'United Kingdom'},{code:'AU',name:'Australia'},{code:'NZ',name:'New Zealand'},{code:'AE',name:'United Arab Emirates'},{code:'SG',name:'Singapore'}],
 buyerTitles:['CMO','VP Marketing','VP Sales','CEO','Operations','Sales Manager','Sales Head'],
 industries:['IT & Services','Construction','Marketing & Advertising','Real Estate','Healthcare','Consulting','Software','Consumer Services','Automotive','Education','Design','Hospitality'],
 intentTopics:['HubSpot','Monday.com','SEO','Website','CRM','Marketing Automation'],
};
export const intentSetup={ready:false,code:'apollo_intent_access_unverified',reason:'Apollo buying-intent search access and topic mappings need verification. Company-only discovery is paused.'} as const;
export const intentWorkflowProfile={version:8,name:'ICP and buying intent',sendingEnabled:false,maxResearch:3,maxCandidates:5,icp:intentIcp,discoverySetup:intentSetup};
/** The published REST schema has no topic search parameter. Never invent or silently omit one. */
export function requireIntentDiscovery(){throw new Error(intentSetup.code);}
