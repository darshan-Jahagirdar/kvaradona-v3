import {z} from 'zod';
import {userClient} from '../../../src/persistence/server';
import {Packet} from '../../../src/contracts/pipeline';
export async function GET(request:Request){
 const params=new URL(request.url).searchParams,parsed=z.object({id:z.string().uuid(),viewport:z.enum(['mobile','desktop'])}).safeParse({id:params.get('opportunity'),viewport:params.get('viewport')});
 if(!parsed.success)return Response.json({error:'Invalid artifact request'},{status:400});
 const client=await userClient(),{data:{user}}=await client.auth.getUser();if(!user)return Response.json({error:'Sign in required'},{status:401});
 const {data,error}=await client.from('opportunities').select('organization_id,packet').eq('id',parsed.data.id).single();if(error||!data)return Response.json({error:'Artifact unavailable'},{status:404});
 const p=Packet.safeParse(data.packet),capture=p.success?p.data.websiteSupplement?.capture:undefined;
 const artifact=capture?.screenshots.find(s=>s.viewport===parsed.data.viewport);
 if(!capture||!artifact||artifact.path!==`${data.organization_id}/${capture.id}/${parsed.data.viewport}.png`)return Response.json({error:'Artifact unavailable'},{status:404});
 const result=await client.storage.from('website-captures').download(artifact.path);
 if(result.error||!result.data||result.data.size>2000000)return Response.json({error:'Artifact unavailable'},{status:404});
 return new Response(result.data,{headers:{'Content-Type':'image/png','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
