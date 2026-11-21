// Календарные месяцы в UTC. 31 января + 1 месяц = 28/29 февраля (конец месяца не «переливается»).
export function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(date.getUTCDate(), lastDayOfTarget);
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

// Новая дата окончания. Действующая подписка продлевается от её конца,
// истёкшая или отсутствующая отсчитывается от текущего момента.
export function computeTargetExpireAt(currentExpireAt: Date | null, months: number, now: Date = new Date()): Date {
  const base = currentExpireAt && currentExpireAt > now ? currentExpireAt : now;
  return addMonths(base, months);
}
