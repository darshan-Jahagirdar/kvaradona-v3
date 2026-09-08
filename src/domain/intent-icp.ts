import {intentIcp} from './intent-target';
import {activeIntentTopics} from './intent-topics';
import {exploriumSearchDefinition} from './explorium-icp';
export {intentIcp} from './intent-target';
export const intentSetup={ready:true,code:'intent_topics_configured',reason:'Six-topic intent search configured. First multi-topic live outcome remains unmeasured.'} as const;
export const intentCoverage='This bounded test targets 501–10,000 employees, matching the configured provider bands. Companies below 501 are outside this test.';
export const intentWorkflowProfile={version:11,name:'Six-topic intent · company research',sendingEnabled:false,maxResearch:4,maxCandidates:4,icp:intentIcp,activeIntentTopics,discoverySetup:intentSetup,coverage:intentCoverage,groups:[{source:'explorium',region:'unspecified',country:'US',language:'en',page:1,query:'',searchDefinition:exploriumSearchDefinition()}]};
/** Apollo company-only discovery stays disabled; intent discovery has its own source. */
export function requireIntentDiscovery(){throw new Error('apollo_intent_access_unverified');}
