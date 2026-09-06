import {z} from 'zod';
import {readFile} from 'node:fs/promises';
import {serviceClient} from '../src/persistence/client';
const id=z.string().uuid().parse(process.argv[2]),c=serviceClient(),project=JSON.parse(await readFile('.local/project.json','utf8'));
const {data,error}=await c.from('campaigns').select('id').eq('id',id).eq('organization_id',project.organizationId).single();if(error||!data)throw Error('campaign_unavailable');
const result=await c.rpc('queue_discovery',{p_campaign:id});if(result.error)throw Error(result.error.message);
console.log(JSON.stringify(result.data));
