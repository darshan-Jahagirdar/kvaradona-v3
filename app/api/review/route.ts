import { NextResponse,type NextRequest } from 'next/server';
import { z } from 'zod';
import { userClient } from '../../../src/persistence/server';
import { Draft } from '../../../src/contracts/pipeline';
const Command=z.object({id:z.string().uuid(),revision:z.number().int().positive(),requestKey:z.string().uuid(),action:z.enum(['edit','defer','reject','research']),note:z.string().trim().min(1).max(3000),draft:Draft.nullable()});
export async function POST(req:NextRequest){
 if(req.headers.get('origin')!==req.nextUrl.origin)return NextResponse.json({error:'Invalid request origin'},{status:403});
 if(Number(req.headers.get('content-length')??0)>16000)return NextResponse.json({error:'Request too large'},{status:413});
 let input;try{const raw=await req.text();if(raw.length>16000)throw new Error();input=Command.parse(JSON.parse(raw));}catch{return NextResponse.json({error:'A valid review note and current version are required.'},{status:400});}
 const client=await userClient();const {data:{user}}=await client.auth.getUser();if(!user)return NextResponse.json({error:'Sign in required'},{status:401});
 const {data,error}=await client.rpc('review_opportunity',{p_id:input.id,p_revision:input.revision,p_request:input.requestKey,p_action:input.action,p_note:input.note,p_draft:input.draft});
 if(error)return NextResponse.json({error:error.message==='stale_version'?'This opportunity changed. Reload before reviewing.':'Review could not be saved.'},{status:409});
 return NextResponse.json({id:data.id},{headers:{'Cache-Control':'no-store'}});
}
