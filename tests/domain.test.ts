import {expect,it} from 'vitest';
import {modelCost,money,usd} from '../src/usage/money';
import {publicAddress,robotsAllows} from '../src/capture/fetch';
import {findings} from '../src/capture/specialists';
import {eventKey,selectObservation,contactPending,isFresh,validateResearch,hash} from '../src/domain/policy';
it('keeps exact decimal usage, including cache writes and reasoning billed as output',()=>{
 expect(modelCost('gpt-5.6-terra',4000,800)).toBe('0.01760000');expect(modelCost('gpt-5.6-luna',2000,400)).toBe('0.00088000');
 expect(usd(money('0.0176')*3n+money('0.00088')*2n)).toBe('0.05456000');
 expect(modelCost('gpt-5.6-terra',100,0,0,100)).toBe('0.00025000');expect(()=>modelCost('unknown-model',10,10)).toThrow();
});
it('blocks private, reserved and mapped-address destinations and honors disallow',()=>{
 for(const address of ['127.0.0.1','10.1.2.3','169.254.169.254','100.64.1.2','::1','::ffff:127.0.0.1','2001:db8::1'])expect(publicAddress(address)).toBe(false);
 expect(publicAddress('8.8.8.8')).toBe(true);expect(robotsAllows('User-agent: *\nDisallow: /private','/private/report')).toBe(false);
});
it('deduplicates tracking aliases while retaining unknown values and operational contact state',()=>{
 expect(eventKey('https://example.com/a?utm_source=x')).toBe(eventKey('https://example.com/a'));
 expect(selectObservation([{value:'50',source:'a',at:'2026-09-01'},{value:'500',source:'b',at:'2026-09-02'}]).conflict).toBe(true);
 expect(contactPending('Operations','Provider unavailable').state).toBe('contact_pending');expect(isFresh(null,30)).toBe(false);
});
it('allows zero CRO/AEO findings and states measurable observations without invented outcomes',()=>{
 const m={title:'Useful page',viewportWidth:390,documentWidth:390,fields:1,unlabeledFields:0,smallTargets:0,h1:1,h2:2,description:'Clear answer',robots:null,canonical:null,mainText:'Service details'};
 expect(findings(m,'cro')).toEqual([]);expect(findings(m,'aeo')).toEqual([]);
 expect(findings({...m,unlabeledFields:2},'cro')[0].observation).toContain('2 visible');
 expect(findings({...m,robots:'noindex'},'aeo')[0].hypothesis).toContain('deliberate');
});
