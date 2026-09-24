export interface UkParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  offset: string;
}

const FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'longOffset',
});

export function ukParts(ms: number): UkParts {
  const map: Record<string, string> = {};
  for (const p of FMT.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const raw = map.timeZoneName ?? 'GMT';
  const m = raw.match(/GMT([+-])(\d{2}):(\d{2})/);
  const offset = !m ? '+00:00' : `${m[1]}${m[2]}:${m[3]}`;
  return {
    year: map.year ?? '0000',
    month: map.month ?? '01',
    day: map.day ?? '01',
    hour: map.hour ?? '00',
    minute: map.minute ?? '00',
    second: map.second ?? '00',
    offset,
  };
}

export function ukOffsetMs(ms: number): number {
  const { offset } = ukParts(ms);
  const m = offset.match(/([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  const sign = m[1] === '+' ? 1 : -1;
  return sign * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
}

export function ukDateKey(ms: number): string {
  const p = ukParts(ms);
  return `${p.year}${p.month}${p.day}`;
}

export function ukDateIso(ms: number): string {
  const p = ukParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}

export function ukStamp(ms: number): string {
  const p = ukParts(ms);
  const frac = String(ms % 1000).padStart(3, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${frac}${p.offset}`;
}

export function ukClock(ms: number): string {
  const p = ukParts(ms);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second} UK`;
}

/** UK calendar midnight in epoch ms. Session for sweep context — not a fire window. */
export function ukMidnightMs(ms: number): number {
  const p = ukParts(ms);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), 0, 0, 0);
  let guess = asUtc;
  for (let i = 0; i < 3; i++) guess = asUtc - ukOffsetMs(guess);
  return guess;
}
