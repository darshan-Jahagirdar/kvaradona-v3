import {expect,it} from 'vitest';
import {sameRequestOrigin} from '../src/domain/request-origin';
it('accepts the exact local or deployed request origin and rejects missing, cross-site, protocol or port mismatches',()=>{
 expect(sameRequestOrigin('http://127.0.0.1:3001','127.0.0.1:3001','http:')).toBe(true);
 expect(sameRequestOrigin('https://review.example','review.example','https:')).toBe(true);
 for(const origin of [null,'null','https://other.example','http://review.example','https://review.example:444','https://review.example@other.example'])expect(sameRequestOrigin(origin,'review.example','https:')).toBe(false);
});
