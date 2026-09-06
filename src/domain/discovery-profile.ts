import {campaignProfile} from './policy';
export const complementaryProfile={...campaignProfile,version:4,name:'HubSpot needs · complementary regional discovery',maxResearch:1,groups:campaignProfile.groups.flatMap(g=>[
 {source:'theirstack',region:g.region,country:g.country,language:g.language,query:'',jobTitlePatterns:['revenue operations|marketing operations|sales operations|CRM|HubSpot'],jobDescriptionPatterns:['(?i)hubspot'],postedWithinDays:30},
 {source:'brave',region:g.region,country:g.country,language:g.language,query:'"HubSpot" ("integration" OR "migration" OR "implementation") ("revenue operations" OR "marketing operations") -template -guide'},
])};
