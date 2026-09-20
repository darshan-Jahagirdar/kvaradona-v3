import {NextResponse,type NextRequest} from 'next/server';
import {z} from 'zod';
import {userClient} from '../../../src/persistence/server';
import {sameRequestOrigin} from '../../../src/domain/request-origin';
import {selectedRunSummary} from '../../../src/domain/selected-run';

const Command=z.object({
 organizationId:z.string().uuid(),
 // A cohort may span source campaigns; each company keeps its own. No campaign is passed in.
 opportunityIds:z.array(z.string().uuid()).min(1).max(25),
 requestKey:z.string().uuid(),
});

/** Launch failures are explained in product terms. Setup problems surface before any batch work. */
const launchMessages:Record<string,string>={
 membership_required:'Organization access is required.',
 selection_required:'Choose at least one company before running the workflow.',
 selection_too_large:'Select 25 companies or fewer for one run.',
 campaign_not_found:'None of the selected companies belong to this organization.',
 campaign_paused:'A source campaign is paused. Resume it before running the workflow.',
 live_disabled:'Live execution is paused. No work was launched.',
 budget_paused:'Budget paused. Existing spending and unresolved reservations count toward the authorized cumulative cap.',
 provider_unverified:'OpenAI or Brave is not verified. No work was launched.',
 no_selectable_companies:'None of the selected companies could start: they are excluded, already running, or held by an unresolved operation.',
};

export async function POST(req:NextRequest){
 if(!sameRequestOrigin(req.headers.get('origin'),req.headers.get('host'),req.nextUrl.protocol))
  return NextResponse.json({error:'Invalid request origin'},{status:403});
 let input;
 try{const raw=await req.text();if(raw.length>4000)throw Error();input=Command.parse(JSON.parse(raw));}
 catch{return NextResponse.json({error:'A valid selected-company request is required.'},{status:400});}
 const c=await userClient(),{data:{user}}=await c.auth.getUser();
 if(!user)return NextResponse.json({error:'Sign in required'},{status:401});
 // Membership, campaign ownership and per-company selectability are all validated server side.
 const {data,error}=await c.rpc('start_selected_workflow',{
  p_organization:input.organizationId,
  p_opportunities:input.opportunityIds,p_request:input.requestKey,
 });
 if(error)return NextResponse.json({error:launchMessages[error.message]??'The run could not be queued. Retry safely with the same request.'},{status:409});
 return NextResponse.json({runId:data.id,created:data.created,queued:data.queued,skipped:data.skipped??[],campaigns:data.campaigns??[]},{headers:{'Cache-Control':'no-store'}});
}

export async function GET(req:NextRequest){
 const c=await userClient(),{data:{user}}=await c.auth.getUser();
 if(!user)return NextResponse.json({error:'Sign in required'},{status:401});
 const organizationId=req.nextUrl.searchParams.get('organizationId');
 const runId=req.nextUrl.searchParams.get('runId');
 if(!organizationId)return NextResponse.json({error:'organizationId is required'},{status:400});
 const companies=await c.rpc('selectable_companies',{p_organization:organizationId});
 if(companies.error)return NextResponse.json({error:'Company list unavailable'},{status:503});
 let run=null;
 if(runId){
  const status=await c.rpc('selected_run_status',{p_organization:organizationId,p_run:runId});
  if(status.error)return NextResponse.json({error:'Run status unavailable'},{status:503});
  run=selectedRunSummary(status.data);
 }
 const worker=await c.rpc('workflow_worker_status');
 return NextResponse.json({companies:companies.data??[],run,worker:worker.data??null},{headers:{'Cache-Control':'no-store'}});
}
