import { BadRequestException } from '@nestjs/common';

export function isoDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function parseEventDate(raw: unknown, label = 'La date'): Date {
  const s = String(raw ?? '').trim();
  if (!s) throw new BadRequestException(`${label} est obligatoire.`);
  const d = new Date(s.length <= 10 ? `${s}T12:00:00` : s);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${label} est invalide.`);
  return d;
}

export function resolveWorkshopDates(start: Date, endRaw: unknown): { eventDate: Date; endDate: Date } {
  const endDate = endRaw == null || String(endRaw).trim() === '' ? start : parseEventDate(endRaw, 'La date de fin');
  if (isoDateKey(endDate) < isoDateKey(start)) {
    throw new BadRequestException(
      'La date de fin doit être postérieure ou égale à la date de commencement.',
    );
  }
  return { eventDate: start, endDate };
}

export function formatDateLongFr(d: Date): string {
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatDateShortFr(d: Date): string {
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateRangeLongFr(start: Date, end?: Date | null): string {
  const endDate = end ?? start;
  if (isoDateKey(start) === isoDateKey(endDate)) return formatDateLongFr(start);
  return `${formatDateLongFr(start)} – ${formatDateLongFr(endDate)}`;
}

export function formatDateRangeShortFr(start: Date, end?: Date | null): string {
  const endDate = end ?? start;
  if (isoDateKey(start) === isoDateKey(endDate)) return formatDateShortFr(start);
  return `${formatDateShortFr(start)} – ${formatDateShortFr(endDate)}`;
}

export function workshopEnd(w: { eventDate: Date; endDate?: Date | null }): Date {
  return w.endDate ?? w.eventDate;
}
