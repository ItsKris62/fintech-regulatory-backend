import { TRPCError } from '@trpc/server';

/** Shared "1d" / "24h" style window parser for every agents.automation.* procedure that takes a `window` input. */
export function parseWindowDays(window: string): number {
  const match = /^(\d+)\s*([dh])$/i.exec(window.trim());
  if (!match) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Unrecognized window "${window}". Expected a duration like "1d" or "24h".`,
    });
  }
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const days = unit === 'h' ? value / 24 : value;
  if (!(days > 0)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `window "${window}" must resolve to a positive duration.` });
  }
  return days;
}

/** Comma-separated jurisdiction filter parser, shared across getSources/fetchSource/getMetrics/etc. */
export function parseJurisdictionFilter(jurisdictions: string | undefined): string[] | null {
  if (!jurisdictions) return null;
  const list = jurisdictions.split(',').map((j) => j.trim()).filter(Boolean);
  return list.length > 0 ? list : null;
}
