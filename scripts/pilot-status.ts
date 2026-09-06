import { serviceClient } from '../src/persistence/client';
const c=serviceClient();
const [opps,ops,jobs]=await Promise.all([c.from('opportunities').select('id,state,packet'),c.from('provider_operations').select('id,provider,state,reserved_usd,actual_usd,usage,response'),c.from('jobs').select('id,stage,status,error')]);
if(opps.error||ops.error||jobs.error)throw new Error('status_read_failed');
console.log(JSON.stringify({opportunities:opps.data?.map(o=>({id:o.id,state:o.state,candidate:o.packet.candidate,notes:o.packet.notes,evidenceCount:o.packet.evidence?.length,researchDecision:o.packet.research?.decision,draftReview:o.packet.draftReview?.acceptable})),operations:ops.data?.map(({response,...o})=>o),jobs:jobs.data},null,2));
