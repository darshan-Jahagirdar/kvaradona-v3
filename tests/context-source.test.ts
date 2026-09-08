import {it,expect,vi,beforeEach} from 'vitest';
import {Readable} from 'node:stream';
const mocks=vi.hoisted(()=>({request:vi.fn(),lookup:vi.fn()}));
vi.mock('node:dns/promises',()=>({lookup:mocks.lookup}));
vi.mock('undici',()=>({Agent:class{async close(){}},request:mocks.request}));
import {fetchEvidence} from '../src/capture/fetch';
import {robotsAllows} from '../src/capture/robots';
beforeEach(()=>{mocks.request.mockReset();mocks.lookup.mockReset().mockResolvedValue([{address:'8.8.8.8',family:4}]);});
const response=(text:string,type='text/plain',statusCode=200,location?:string)=>({statusCode,headers:{'content-type':type,location},body:Readable.from([Buffer.from(text)])});
const page='<html><title>Company</title><main>'+('Company services and public information. '.repeat(10))+'</main></html>';
it('matches the Citrix and WPI wildcard patterns without blocking every page',()=>{
 const rules='User-agent: *\nDisallow: /*.print.html\nDisallow: /*/media/oembed\nDisallow: /*?*';
 expect(robotsAllows(rules,'/')).toBe(true);
 for(const path of ['/news.print.html','/en/media/oembed','/?page=1'])expect(robotsAllows(rules,path)).toBe(false);
 expect(robotsAllows('User-agent: *\nDisallow: /private$','/private/page')).toBe(true);
 expect(robotsAllows('User-agent: *\nDisallow: /private$','/private')).toBe(false);
 expect(robotsAllows('User-agent: *\nDisallow: /*.pdf$','/docs/a.pdf?x=1')).toBe(true);
});
it('merges consecutive and repeated matching agent groups, prefers specific groups and Allow ties',()=>{
 const rules='User-agent: *\nDisallow: /\nUser-agent: OtherBot\nUser-agent: KvaradonaResearch\nDisallow: /private\nAllow: /private/public\nUser-agent: kvaradonaresearch\nDisallow: /second\nAllow: /second';
 expect(robotsAllows(rules,'/')).toBe(true);expect(robotsAllows(rules,'/private')).toBe(false);
 expect(robotsAllows(rules,'/private/public')).toBe(true);expect(robotsAllows(rules,'/second')).toBe(true);
 expect(robotsAllows('User-agent: *\nDisallow:\nDisallow: /caf%C3%A9','/café')).toBe(false);
 expect(robotsAllows('User-agent: *\nDisallow: /%7Euser','/~user')).toBe(false);
 expect(robotsAllows('User-agent: *\nDisallow: /a%2Fb','/a/b')).toBe(true);
});
it('retries the canonical www host after a bare-host certificate error with normal validation',async()=>{
 mocks.request.mockRejectedValueOnce(Object.assign(Error('certificate'),{code:'UNABLE_TO_VERIFY_LEAF_SIGNATURE'})).mockResolvedValueOnce(response('User-agent: *\nDisallow: /*/media/oembed')).mockResolvedValueOnce(response(page,'text/html'));
 const attempts:any[]=[];const e=await fetchEvidence('https://example.com/',a=>attempts.push(a));
 expect(e.accountHost).toBe('example.com');expect(e.finalUrl).toBe('https://www.example.com/');
 expect(mocks.lookup.mock.calls.map(c=>c[0])).toEqual(['example.com','www.example.com','www.example.com']);
 expect(attempts[0]).toMatchObject({stage:'robots',code:'UNABLE_TO_VERIFY_LEAF_SIGNATURE'});
});
it('classifies a robots redirect to a large HTML homepage before reading its body',async()=>{
 const html=response('x'.repeat(200000),'text/html');
 mocks.request.mockResolvedValueOnce(response('',undefined,301,'https://www.example.com/')).mockResolvedValueOnce(html).mockResolvedValueOnce(response('User-agent: *\nDisallow: /private')).mockResolvedValueOnce(response(page,'text/html'));
 const attempts:any[]=[];await fetchEvidence('https://example.com/',a=>attempts.push(a));
 expect(html.body.destroyed).toBe(true);expect(attempts[0]).toMatchObject({stage:'robots',code:'robots_invalid_format',status:200});
 expect(mocks.request.mock.calls.map(c=>c[0].href)).toContain('https://www.example.com/robots.txt');
});
it('does not bypass a genuine robots denial, unsafe DNS or rate limit with a canonical retry',async()=>{
 mocks.request.mockResolvedValueOnce(response('User-agent: *\nDisallow: /'));
 await expect(fetchEvidence('https://example.com/')).rejects.toThrow('robots_disallowed');expect(mocks.request).toHaveBeenCalledTimes(1);
 mocks.request.mockClear();mocks.lookup.mockResolvedValueOnce([{address:'127.0.0.1',family:4}]);
 await expect(fetchEvidence('https://example.com/')).rejects.toThrow('unsafe_destination');expect(mocks.request).not.toHaveBeenCalled();
 mocks.request.mockResolvedValueOnce(response('x'.repeat(200000),'text/html',429));
 await expect(fetchEvidence('https://example.com/')).rejects.toMatchObject({detail:{stage:'robots',status:429,code:'robots_unavailable'}});expect(mocks.request).toHaveBeenCalledTimes(1);
});
