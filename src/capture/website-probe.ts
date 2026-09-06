import type {Page} from 'playwright';
import {readFileSync} from 'node:fs';
import type {WebsiteFact} from '../contracts/website';
const browserSource=readFileSync(new URL('./website-probe.browser.js',import.meta.url),'utf8');
// Static browser source avoids tsx/esbuild helper references crossing into Chrome.
export async function websiteProbe(page:Page,viewport:'mobile'|'desktop'){
 return page.evaluate(browserSource+'\ncollectWebsiteFacts('+JSON.stringify(viewport)+')') as Promise<{facts:WebsiteFact[];title:string;bodyText:string;robots:string[];canonical:string|null;description:string|null;structuredData:string[];domContentLoadedMs:number|null}>;
}
