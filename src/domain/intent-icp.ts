import {intentIcp} from './intent-target';
import {activeIntentTopics} from './intent-topics';
import {exploriumSearchDefinition} from './explorium-icp';
export {intentIcp} from './intent-target';
export const intentSetup={ready:true,code:'intent_topics_configured',reason:'Six-topic intent search configured. First multi-topic live outcome remains unmeasured.'} as const;
export const intentCoverage='Target: 500–10,000 employees inclusive. Current provider bands cover 501–10,000; exactly-500 companies need a separate verified route.';
export const intentWorkflowProfile={version:10,name:'Six-topic intent · company research',sendingEnabled:false,maxResearch:4,maxCandidates:4,icp:intentIcp,activeIntentTopics,discoverySetup:intentSetup,coverage:intentCoverage,groups:[{source:'explorium',region:'unspecified',country:'US',language:'en',page:1,query:'',searchDefinition:exploriumSearchDefinition()}]};
/** Apollo company-only discovery stays disabled; intent discovery has its own source. */
export function requireIntentDiscovery(){throw new Error('apollo_intent_access_unverified');}
