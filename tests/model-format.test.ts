import {expect,it} from 'vitest';
import {Draft,ProcurementDraft} from '../src/contracts/pipeline';
import {modelTextFormat} from '../src/ai/format';
it('uses supported transport constraints while preserving strict local draft validation',()=>{
 const output=modelTextFormat(Draft,'draft');const json=JSON.stringify(output);
 expect(json).not.toMatch(/maxLength|minLength|\(\?!/);
 expect(json).toContain('"format":"email"');
 expect(output).toMatchObject({strict:true,schema:{type:'object',additionalProperties:false,required:['subject','body','recipient','sender','claimIds']}});
 const draft={subject:'A useful outline',body:'Would a short outline help?',sender:null,recipient:null,claimIds:[]};
 expect(Draft.safeParse(draft).success).toBe(true);
 expect(Draft.safeParse({...draft,recipient:'invalid'}).success).toBe(false);
 expect(Draft.safeParse({...draft,subject:'x'.repeat(201)}).success).toBe(false);
 expect(Draft.safeParse({...draft,body:'x'.repeat(6001)}).success).toBe(false);
});

it('keeps the procurement response schema a strict object with cited requirements',()=>{
 const format=modelTextFormat(ProcurementDraft,'procurement_draft');expect(format.schema).toMatchObject({type:'object',additionalProperties:false});expect(JSON.stringify(format.schema)).toContain('"procurement"');expect(JSON.stringify(format.schema)).not.toMatch(/maxLength|minLength/);
});
