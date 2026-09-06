/** Fixed point USD at 1e-8 precision. No floating point accumulation. */
export function money(value: string): bigint {
  if (!/^\d+(\.\d{1,8})?$/.test(value)) throw new Error('invalid_money');
  const [whole, fraction=''] = value.split('.'); return BigInt(whole)*100000000n+BigInt(fraction.padEnd(8,'0'));
}
export function usd(value: bigint) { if (value<0n) throw new Error('negative_money'); return `${value/100000000n}.${(value%100000000n).toString().padStart(8,'0')}`; }
export const prices = {
  'gpt-5.6-luna': { input: 20n, cached: 2n, output: 120n },
  'gpt-5.6-terra': { input: 200n, cached: 20n, output: 1200n },
  'gpt-5.6-sol': { input: 400n, cached: 40n, output: 2000n },
  'gpt-6-astra': { input: 1000n, cached: 100n, output: 5000n },
} as const;
export type Model = keyof typeof prices;
export function modelCost(model: string, input: number, output: number, cached=0, cacheWrite=0) {
  const p = prices[model as Model]; if (!p) throw new Error('unknown_model_price');
  if (![input,output,cached,cacheWrite].every(n=>Number.isSafeInteger(n)&&n>=0) || cached+cacheWrite>input) throw new Error('invalid_usage');
  return usd(BigInt(input-cached-cacheWrite)*p.input+BigInt(cached)*p.cached+BigInt(output)*p.output+(BigInt(cacheWrite)*p.input*5n+3n)/4n);
}
export const PRICE_VERSION = '2026-09-06-standard-text';
