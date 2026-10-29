import moment from 'moment-timezone';

export function homeSummary(total: number, done: number, now: Date, timeZone?: string) {
  const hour = timeZone && moment.tz.zone(timeZone) ? moment.tz(now, timeZone).hour() : now.getHours();
  const complete = total === 0 || done >= total;
  return {
    greeting: complete && hour >= 19 ? '今日も1日お疲れ様でした' : '今日も1日頑張りましょう',
    showProgress: total > 0,
    percent: total > 0 ? done >= total ? 100 : Math.min(99, Math.max(0, Math.round(done / total * 100))) : 0,
  };
}

/** Refresh text only at the next greeting boundary; never regenerate a plan for a clock tick. */
export function nextHomeClockDelay(now: Date, timeZone?: string): number {
  const clock = timeZone && moment.tz.zone(timeZone) ? moment.tz(now, timeZone) : moment(now);
  const next = clock.clone().startOf('day').hour(19);
  if (clock.hour() >= 19) next.add(1, 'day').startOf('day');
  return Math.max(1, next.valueOf() - now.getTime() + 50);
}
