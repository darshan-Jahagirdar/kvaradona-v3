import {NextResponse,type NextRequest} from 'next/server';
import {z} from 'zod';
import {userClient} from '../../../src/persistence/server';
import {sameRequestOrigin} from '../../../src/domain/request-origin';
const Command=z.object({organizationId:z.string().uuid(),requestKey:z.string().uuid()});
export async function POST(req:NextRequest){
 if(!sameRequestOrigin(req.headers.get('origin'),req.headers.get('host'),req.nextUrl.protocol))return NextResponse.json({error:'Invalid request origin'},{status:403});
 let input;try{const raw=await req.text();if(raw.length>1000)throw Error();input=Command.parse(JSON.parse(raw));}catch{return NextResponse.json({error:'A valid workflow request is required.'},{status:400});}
 const c=await userClient(),{data:{user}}=await c.auth.getUser();if(!user)return NextResponse.json({error:'Sign in required'},{status:401});
 const {data,error}=await c.rpc('start_workflow',{p_organization:input.organizationId,p_request:input.requestKey});
 if(error){const messages:Record<string,string>={budget_paused:'Budget paused. Existing spending and unresolved reservations count toward the $2 cap.',live_disabled:'Live execution is paused. No work was launched.',provider_unverified:'A required provider is unavailable. No work was launched.',membership_required:'Organization access is required.'};return NextResponse.json({error:messages[error.message]??'Workflow could not be queued. Try again using the same request.'},{status:409});}
 return NextResponse.json({runId:data.id,created:data.created},{headers:{'Cache-Control':'no-store'}});
}
export async function GET(){
 const c=await userClient(),{data:{user}}=await c.auth.getUser();if(!user)return NextResponse.json({error:'Sign in required'},{status:401});
 const [runs,worker,budget]=await Promise.all([c.from('workflow_runs').select('id,campaign_id,created_at').order('created_at',{ascending:false}).limit(1),c.rpc('workflow_worker_status'),c.rpc('operational_status')]);
 if(runs.error||worker.error||budget.error)return NextResponse.json({error:'Workflow status unavailable'},{status:503});
 const run=runs.data?.[0];
 const [jobs,opps]=run?await Promise.all([c.from('jobs').select('id,opportunity_id,stage,status,error').eq('campaign_id',run.campaign_id).order('created_at'),c.from('opportunities').select('id,state,packet').eq('campaign_id',run.campaign_id)]):[{data:[],error:null},{data:[],error:null}];
 if(jobs.error||opps.error)return NextResponse.json({error:'Workflow details unavailable'},{status:503});
 return NextResponse.json({run,worker:worker.data,budget:budget.data,jobs:jobs.data,opportunities:opps.data?.map(o=>({id:o.id,state:o.state,name:o.packet.research?.company??o.packet.candidate?.procurementNotice?.buyer??o.packet.candidate?.providerRecord?.company??o.packet.candidate?.title??'Source being checked'}))},{headers:{'Cache-Control':'no-store'}});
}
