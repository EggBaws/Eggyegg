/** Hard-reject reason codes from spec §6. A clock by itself is never a reason code. */
export const SPIT = {
  HOLIDAY: 'HOLIDAY',
  FAKE_NECK: 'FAKE_NECK',
  NO_FVG: 'NO_FVG',
  NO_SWEEP: 'NO_SWEEP',
  CHASE: 'CHASE',
  FAT_STOP: 'FAT_STOP',
  NEED_DEEPER: 'NEED_DEEPER',
  ALREADY_USED: 'ALREADY_USED',
  SECOND_ON_SAME_BOX: 'SECOND_ON_SAME_BOX',
  VENUE_UNHEALTHY: 'VENUE_UNHEALTHY',
  LIVE_OFF: 'LIVE_OFF',
  DAILY_KILL: 'DAILY_KILL',
} as const;

export type SpitCode = (typeof SPIT)[keyof typeof SPIT];

export const SPIT_CODES: SpitCode[] = Object.values(SPIT);

/**
 * HOLIDAY is warn-only. LIVE_OFF still paints, pings, and writes a dry-run LIMIT.
 * Neither one stops detection or the paper fire path.
 */
export function isBlockingSpit(code: SpitCode): boolean {
  return code !== SPIT.HOLIDAY && code !== SPIT.LIVE_OFF;
}
