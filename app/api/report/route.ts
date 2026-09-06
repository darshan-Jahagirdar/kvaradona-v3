import {NextResponse} from 'next/server';
import {userClient} from '../../../src/persistence/server';
import {batchReport} from '../../../src/domain/batch-report';
export async function GET(){const c=await userClient();const {data:{user}}=await c.auth.getUser();if(!user)return NextResponse.json({error:'Sign in required'},{status:401});
 const [rows,labels,status,operations]=await Promise.all([c.from('opportunities').select('id,revision,packet_hash,packet').order('created_at').limit(500),c.from('quality_labels').select('opportunity_id,packet_hash,labels').order('created_at',{ascending:false}).limit(1000),c.rpc('operational_status'),c.from('provider_operations').select('provider,opportunity_id,campaign_id,usage,actual_usd,reserved_usd,state,units').order('created_at',{ascending:false}).limit(1000)]);
 if(rows.error||labels.error||status.error||operations.error)return NextResponse.json({error:'Report unavailable'},{status:503});return NextResponse.json({...batchReport(rows.data,labels.data),usage:status.data,providerOperations:operations.data,truncated:operations.data.length===1000||rows.data.length===500||labels.data.length===1000},{headers:{'Cache-Control':'no-store','Content-Disposition':'attachment; filename="kvaradona-poc-report.json"'}});
}
