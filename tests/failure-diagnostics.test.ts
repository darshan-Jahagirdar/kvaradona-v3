import {expect,it} from 'vitest';
import {failureDiagnostics} from '../src/usage/failure';
it('retains useful provider status without logging error messages, headers or credentials',()=>{
 const raw={status:400,code:'unsupported_parameter',param:'reasoning.effort',request_id:'req_fixture',message:'Sensitive upstream message',headers:{authorization:'Bearer fixture-secret'},apiKey:'fixture-secret'};
 expect(failureDiagnostics(raw)).toEqual({httpStatus:400,code:'unsupported_parameter',parameter:'reasoning.effort',requestId:'req_fixture'});
 expect(JSON.stringify(failureDiagnostics(raw))).not.toContain('secret');
 expect(failureDiagnostics({status:NaN,code:'sk-secret',param:'Bearer secret',request_id:'secret'})).toEqual({httpStatus:null,code:null,parameter:null,requestId:null});
});
