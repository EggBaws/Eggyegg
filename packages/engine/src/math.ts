export const EPS = 1e-8;

export function lte(a: number, b: number): boolean {
  return a <= b + EPS;
}

export function gte(a: number, b: number): boolean {
  return a >= b - EPS;
}

export function tickDecimals(tick: number): number {
  const s = tick.toString().toLowerCase();
  if (s.includes('e-')) {
    const exp = Number(s.split('e-')[1]);
    return exp;
  }
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

export function roundToTick(price: number, tick: number, dir: 'nearest' | 'floor' | 'ceil'): number {
  if (!(tick > 0)) return price;
  const n = price / tick;
  const k =
    dir === 'floor' ? Math.floor(n + 1e-9) : dir === 'ceil' ? Math.ceil(n - 1e-9) : Math.round(n);
  return Number((k * tick).toFixed(tickDecimals(tick)));
}

export function formatPrice(price: number, tick: number): string {
  return price.toFixed(tickDecimals(tick));
}

export function roundQtyDown(qty: number): number {
  return Math.floor(qty * 1e8 + 1e-9) / 1e8;
}
