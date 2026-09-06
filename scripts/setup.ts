import { randomBytes } from 'node:crypto';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { z } from 'zod';
import { serviceClient } from '../src/persistence/client';
import { campaignProfile } from '../src/domain/policy';
const client=serviceClient();
const email=z.string().email().parse(process.argv[2]);
const {data:users,error:usersError}=await client.auth.admin.listUsers({page:1,perPage:100});if(usersError)throw new Error('user_list_failed');
let user=users.users.find(u=>u.email===email);
if(!user){
 const password=randomBytes(24).toString('base64url');
 const {data,error}=await client.auth.admin.createUser({email,password,email_confirm:true});if(error||!data.user)throw new Error('user_create_failed');user=data.user;
 await mkdir('.local',{recursive:true});await writeFile('.local/review-login.json',JSON.stringify({email,password},null,2),{mode:0o600});
}
const {data:membership,error:memberError}=await client.from('memberships').select('organization_id').eq('user_id',user.id).maybeSingle();if(memberError)throw new Error('membership_read_failed');
let org=membership?.organization_id;
if(!org){const {data,error}=await client.from('organizations').insert({name:'Your company · V3 POC'}).select('id').single();if(error)throw new Error('organization_create_failed');org=data.id;
 const {error:memberWrite}=await client.from('memberships').insert({organization_id:org,user_id:user.id,role:'admin'});if(memberWrite)throw new Error('membership_create_failed');}
const {data:existing,error:campaignError}=await client.from('campaigns').select('id').eq('organization_id',org).eq('name',campaignProfile.name).maybeSingle();if(campaignError)throw new Error('campaign_read_failed');
let campaign=existing?.id;
if(!campaign){const {data,error}=await client.from('campaigns').insert({organization_id:org,name:campaignProfile.name,profile:campaignProfile,paused:true}).select('id').single();if(error)throw new Error('campaign_create_failed');campaign=data.id;}
await mkdir('.local',{recursive:true});await writeFile('.local/project.json',JSON.stringify({organizationId:org,campaignId:campaign,userId:user.id},null,2),{mode:0o600});
const login=JSON.parse(await readFile('.local/review-login.json','utf8'));
const {error:loginError}=await client.auth.signInWithPassword(login);
if(loginError)throw new Error('named_login_failed');await client.auth.signOut();
console.log(JSON.stringify({userProvisioned:true,membership:true,campaignPaused:true,passwordLoginVerified:true,credentialFile:'.local/review-login.json'}));
