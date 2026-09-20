import { NextResponse,type NextRequest } from 'next/server';
import { z } from 'zod';
import { userClient } from '../../../src/persistence/server';
import { StoredDraft } from '../../../src/contracts/pipeline';
import {sameRequestOrigin} from '../../../src/domain/request-origin';
const Command=z.object({id:z.string().uuid(),revision:z.number().int().positive(),requestKey:z.string().uuid(),action:z.enum(['edit','recheck','defer','reject','research','resume','refresh_contact_search']),note:z.string().trim().min(1).max(3000),draft:StoredDraft.nullable()});
export async function POST(req:NextRequest){
 if(!sameRequestOrigin(req.headers.get('origin'),req.headers.get('host'),req.nextUrl.protocol))return NextResponse.json({error:'Invalid request origin'},{status:403});
 if(Number(req.headers.get('content-length')??0)>32000)return NextResponse.json({error:'Request too large'},{status:413});
 let input;try{const raw=await req.text();if(raw.length>32000)throw new Error();input=Command.parse(JSON.parse(raw));}catch{return NextResponse.json({error:'A valid review note and current version are required.'},{status:400});}
 const client=await userClient();const {data:{user}}=await client.auth.getUser();if(!user)return NextResponse.json({error:'Sign in required'},{status:401});
 const {data,error}=await client.rpc('review_opportunity',{p_id:input.id,p_revision:input.revision,p_request:input.requestKey,p_action:input.action,p_note:input.note,p_draft:input.draft});
 if(error)return NextResponse.json({error:error.message==='stale_version'?'This opportunity changed. Reload before reviewing.':error.message==='contact_refresh_reason_and_checked_packet_required'?'A checked research packet and a specific reason (20 characters) are required for a fresh buyer search.':error.message==='recovery_not_available'?'No automatic recovery is available for this state.':error.message==='recovery_in_progress'?'Recovery is already queued or running.':error.message==='ambiguous_operation_hold'?'A provider operation has an unresolved outcome. It must be reconciled before this stage can resume.':'Review could not be saved.'},{status:409});
 return NextResponse.json({id:data.id},{headers:{'Cache-Control':'no-store'}});
}
