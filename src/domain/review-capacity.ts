import {campaignProfile} from './policy';
export function reviewCapacityPolicy(profile:Record<string,unknown>){
 const share=typeof profile.explorationShare==='number'?profile.explorationShare:campaignProfile.explorationShare;
 const capacity=typeof profile.reviewCapacity==='number'?profile.reviewCapacity:typeof profile.maxResearch==='number'&&profile.maxResearch>0?profile.maxResearch:4;
 if(share<0||share>1||!Number.isInteger(capacity)||capacity<1||capacity>100)throw Error('invalid_review_capacity_policy');
 // A selected cohort was chosen by a person, so the exploration cap that protects review from discovery
 // volume does not apply. Recorded on the allocation so the packet states why, and scoped to that campaign.
 const selected=profile.cohortPolicy==='selected';
 return {share,capacity,explorationLimit:selected?capacity:Math.ceil(capacity*share),
  source:selected?'selected-cohort':typeof profile.explorationShare==='number'?'campaign':'default'};
}
