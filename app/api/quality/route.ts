import {NextResponse,type NextRequest} from 'next/server';
import {z} from 'zod';
import {userClient} from '../../../src/persistence/server';
import {sameRequestOrigin} from '../../../src/domain/request-origin';
import {QualityLabels} from '../../../src/contracts/quality';
const Command=z.object({id:z.string().uuid(),revision:z.number().int().positive(),packetHash:z.string().regex(/^[a-f0-9]{32}$/),requestKey:z.string().uuid(),labels:QualityLabels});
export async function POST(req:NextRequest){
 if(!sameRequestOrigin(req.headers.get('origin'),req.headers.get('host'),req.nextUrl.protocol))return NextResponse.json({error:'Invalid origin'},{status:403});
 let input;try{const raw=await req.text();if(raw.length>5000)throw Error();input=Command.parse(JSON.parse(raw));}catch{return NextResponse.json({error:'Complete the quality ratings and note.'},{status:400});}
 const client=await userClient();const {data:{user}}=await client.auth.getUser();if(!user)return NextResponse.json({error:'Sign in required'},{status:401});
 const {error}=await client.rpc('label_opportunity',{p_id:input.id,p_revision:input.revision,p_hash:input.packetHash,p_request:input.requestKey,p_labels:input.labels});
 if(error)return NextResponse.json({error:'Quality review could not be saved.'},{status:409});return NextResponse.json({saved:true},{headers:{'Cache-Control':'no-store'}});
}
