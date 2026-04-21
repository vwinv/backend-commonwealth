/**
 * Année scolaire au format "YYYY-YYYY+1" (ex. 2025-2026).
 * Mensualités générées de septembre (Y1) à juin (Y1+1).
 */
export function billingMonthsForSchoolYear(schoolYear: string): { year: number; month: number }[] {
  const m = schoolYear.trim().match(/^(\d{4})-(\d{4})$/);
  if (!m) return [];
  const y1 = parseInt(m[1]!, 10);
  const y2 = parseInt(m[2]!, 10);
  if (!Number.isFinite(y1) || !Number.isFinite(y2) || y2 !== y1 + 1) return [];
  const out: { year: number; month: number }[] = [];
  for (let month = 9; month <= 12; month++) out.push({ year: y1, month });
  for (let month = 1; month <= 6; month++) out.push({ year: y1 + 1, month });
  return out;
}
