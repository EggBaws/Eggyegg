import { ukDateIso } from './time.ts';

/**
 * England & Wales bank holidays and NYSE full closures.
 * A hit is a warning only. Detection does not stop.
 */
const HOLIDAYS: Record<string, string> = {
  '2025-01-01': 'New Year / NYSE',
  '2025-01-20': 'MLK Day (NYSE)',
  '2025-02-17': 'Presidents Day (NYSE)',
  '2025-04-18': 'Good Friday',
  '2025-04-21': 'Easter Monday (England)',
  '2025-05-05': 'Early May bank holiday (England)',
  '2025-05-26': 'Spring bank holiday / Memorial Day',
  '2025-06-19': 'Juneteenth (NYSE)',
  '2025-07-04': 'Independence Day (NYSE)',
  '2025-08-25': 'Summer bank holiday (England)',
  '2025-09-01': 'Labor Day (NYSE)',
  '2025-11-27': 'Thanksgiving (NYSE)',
  '2025-12-25': 'Christmas Day',
  '2025-12-26': 'Boxing Day',
  '2026-01-01': 'New Year',
  '2026-01-19': 'MLK Day (NYSE)',
  '2026-02-16': 'Presidents Day (NYSE)',
  '2026-04-03': 'Good Friday',
  '2026-04-06': 'Easter Monday (England)',
  '2026-05-04': 'Early May bank holiday (England)',
  '2026-05-25': 'Spring bank holiday / Memorial Day',
  '2026-06-19': 'Juneteenth (NYSE)',
  '2026-07-03': 'Independence Day observed (NYSE)',
  '2026-08-31': 'Summer bank holiday (England)',
  '2026-09-07': 'Labor Day (NYSE)',
  '2026-11-26': 'Thanksgiving (NYSE)',
  '2026-12-25': 'Christmas Day',
  '2026-12-28': 'Boxing Day substitute (England)',
};

export interface HolidayInfo {
  active: boolean;
  name: string | null;
  date: string;
}

export function holidayOn(ukDate: string): HolidayInfo {
  const name = HOLIDAYS[ukDate] ?? null;
  return { active: name != null, name, date: ukDate };
}

export function holidayAt(ms: number): HolidayInfo {
  return holidayOn(ukDateIso(ms));
}
