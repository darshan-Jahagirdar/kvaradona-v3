import {it} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
it('measures DOM evidence in the actual tsx worker runtime without reading entered values',async()=>{
 await promisify(execFile)(process.execPath,['--import','tsx','tests/fixtures/website-probe-runtime.ts'],{timeout:20000});
});
