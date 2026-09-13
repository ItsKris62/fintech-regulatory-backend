/**
 * Billing Date Utilities
 *
 * Precise calendar-month and calendar-year arithmetic for subscriptions and usage accounting.
 *
 * Invariants:
 * 1. Never uses fixed 30-day (2,592,000s) or 365-day (31,536,000s) approximations.
 * 2. End-of-month clamping: e.g. Jan 31 + 1 month -> Feb 28 (or Feb 29 in leap years), Aug 31 + 1 month -> Sep 30.
 * 3. Leap-year clamping: Feb 29 + 1 year -> Feb 28 in non-leap years.
 * 4. UTC storage and calculation consistency.
 * 5. Early renewal preserves already-paid service time.
 * 6. Annual billing period and monthly usage quota periods are strictly separated.
 */

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function getDaysInMonth(year: number, monthIndex0: number): number {
  // monthIndex0: 0 = Jan, 1 = Feb, ..., 11 = Dec
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

/**
 * Adds calendar months to a UTC Date, clamping day-of-month to the target month's maximum.
 * If anchorDay is provided, preserves the original billing anchor day across short months.
 */
export function addCalendarMonths(date: Date, months: number, anchorDay?: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = anchorDay ?? date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = date.getUTCSeconds();
  const ms = date.getUTCMilliseconds();

  const totalMonths = month + months;
  const targetYear = year + Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;

  const maxDays = getDaysInMonth(targetYear, targetMonth);
  const targetDay = Math.min(day, maxDays);

  return new Date(Date.UTC(targetYear, targetMonth, targetDay, hours, minutes, seconds, ms));
}

/**
 * Adds calendar years to a UTC Date, clamping Feb 29 to Feb 28 on non-leap years.
 */
export function addCalendarYears(date: Date, years: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = date.getUTCSeconds();
  const ms = date.getUTCMilliseconds();

  const targetYear = year + years;
  let targetDay = day;

  // Leap year edge case: Feb 29 in leap year -> Feb 28 in non-leap year
  if (month === 1 && day === 29 && !isLeapYear(targetYear)) {
    targetDay = 28;
  }

  return new Date(Date.UTC(targetYear, month, targetDay, hours, minutes, seconds, ms));
}

/**
 * Computes the next billing cycle start and end dates based on subscription interval.
 *
 * - For early renewals, preserves remaining prepaid service:
 *   If paidThrough > now, starts at paidThrough and extends by 1 month or 1 year.
 * - For expired or new subscriptions, starts at now and extends by 1 month or 1 year.
 * - Preserves the original billing anchorDay across short-month clamping.
 */
export function computeSubscriptionCycle(params: {
  interval: 'monthly' | 'yearly';
  paidThrough?: Date | null;
  anchorDay?: number;
  now?: Date;
}): { billingPeriodStart: Date; billingPeriodEnd: Date } {
  const now = params.now ?? new Date();
  const paidThrough = params.paidThrough;

  const billingPeriodStart = paidThrough && paidThrough > now ? paidThrough : now;
  const anchorDay = params.anchorDay ?? billingPeriodStart.getUTCDate();
  const billingPeriodEnd =
    params.interval === 'yearly'
      ? addCalendarYears(billingPeriodStart, 1)
      : addCalendarMonths(billingPeriodStart, 1, anchorDay);

  return { billingPeriodStart, billingPeriodEnd };
}

/**
 * Returns the current monthly usage entitlement period (UTC calendar month).
 */
export function getMonthlyQuotaPeriod(now = new Date()): {
  periodStart: Date;
  periodEnd: Date;
  periodKey: string;
} {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed

  const periodStart = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  const periodKey = `${year}-${String(month + 1).padStart(2, '0')}`;

  return { periodStart, periodEnd, periodKey };
}
