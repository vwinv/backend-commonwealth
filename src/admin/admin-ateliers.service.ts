import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, WorkshopReservationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

function parseRequiredString(raw: unknown, label: string): string {
  const s = String(raw ?? '').trim();
  if (!s) throw new BadRequestException(`${label} est obligatoire.`);
  return s;
}

function parseOptionalString(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  return s || null;
}

function parseEventDate(raw: unknown): Date {
  const s = String(raw ?? '').trim();
  if (!s) throw new BadRequestException('La date est obligatoire.');
  const d = new Date(s.length <= 10 ? `${s}T12:00:00` : s);
  if (Number.isNaN(d.getTime())) throw new BadRequestException('Date invalide.');
  return d;
}

function parseCapacity(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) throw new BadRequestException('Le nombre de places est invalide.');
  return Math.floor(n);
}

function parseBool(raw: unknown, fallback = false): boolean {
  if (typeof raw === 'boolean') return raw;
  const s = String(raw ?? '').trim().toLowerCase();
  if (['1', 'true', 'oui', 'yes'].includes(s)) return true;
  if (['0', 'false', 'non', 'no'].includes(s)) return false;
  return fallback;
}

function parseStatus(raw: unknown): WorkshopReservationStatus {
  const v = String(raw ?? '').trim().toUpperCase();
  if (v === 'VALIDEE' || v === 'EN_ATTENTE' || v === 'ANNULEE') return v as WorkshopReservationStatus;
  throw new BadRequestException('Statut de réservation invalide.');
}

function formatDateLongFr(d: Date): string {
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function formatDateShortFr(d: Date): string {
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatTimeLabel(start: string, end: string): string {
  const fmt = (t: string) => t.replace(':', 'H');
  return `${fmt(start)} à ${fmt(end)}`;
}

function formatSessionLabel(date: Date, start: string, end: string): string {
  return `${formatDateShortFr(date)}, ${start} - ${end}`;
}

function formatReservedAt(d: Date): string {
  return d.toLocaleString('fr-FR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfToday(): Date {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}

@Injectable()
export class AdminAteliersService {
  constructor(private readonly prisma: PrismaService) {}

  private async nextReservationCode(): Promise<string> {
    const count = await this.prisma.workshopReservation.count();
    return `RES-${String(count + 1).padStart(5, '0')}`;
  }

  async listPublished() {
    const today = startOfToday();
    const workshops = await this.prisma.workshop.findMany({
      where: {
        published: true,
        eventDate: { gte: today },
      },
      orderBy: [{ eventDate: 'asc' }, { startTime: 'asc' }],
    });

    return {
      items: workshops.map((w) => ({
        id: w.id,
        title: w.title,
        description: w.description ?? '',
        image: w.imageUrl,
        date: formatDateLongFr(w.eventDate),
        time: `De ${formatTimeLabel(w.startTime, w.endTime)}`,
        age: w.ageRange || w.recommendedAge || '—',
        price: w.isFree ? 'Gratuit' : w.priceLabel || '—',
        location: w.location ?? '',
        capacity: w.capacity,
        dateValue: w.eventDate.toISOString().slice(0, 10),
        startTime: w.startTime,
        endTime: w.endTime,
      })),
    };
  }

  async getOverview(query: {
    tab?: string;
    search?: string;
    sort?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    const search = String(query.search ?? '').trim().toLowerCase();
    const sort = String(query.sort ?? 'date_desc').trim();
    const dateFrom = String(query.dateFrom ?? '').trim();
    const dateTo = String(query.dateTo ?? '').trim();

    const workshopDateFilter: Prisma.DateTimeFilter = {};
    if (dateFrom) workshopDateFilter.gte = new Date(`${dateFrom}T00:00:00`);
    if (dateTo) workshopDateFilter.lte = new Date(`${dateTo}T23:59:59`);

    const workshopWhere: Prisma.WorkshopWhereInput = {
      ...(Object.keys(workshopDateFilter).length ? { eventDate: workshopDateFilter } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { description: { contains: search, mode: 'insensitive' } },
              { location: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const reservationWhere: Prisma.WorkshopReservationWhereInput = {
      ...(Object.keys(workshopDateFilter).length
        ? { workshop: { eventDate: workshopDateFilter } }
        : {}),
      ...(search
        ? {
            OR: [
              { code: { contains: search, mode: 'insensitive' } },
              { childName: { contains: search, mode: 'insensitive' } },
              { parentName: { contains: search, mode: 'insensitive' } },
              { workshop: { title: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const todayStart = startOfToday();
    const todayEnd = endOfToday();

    const [workshops, reservations, totalReservations, todayCount, validatedCount, pendingCount, cancelledCount] =
      await Promise.all([
        this.prisma.workshop.findMany({
          where: workshopWhere,
          include: {
            _count: {
              select: {
                reservations: { where: { status: { not: WorkshopReservationStatus.ANNULEE } } },
              },
            },
          },
          orderBy:
            sort === 'name_asc'
              ? { title: 'asc' }
              : sort === 'date_asc'
                ? { eventDate: 'asc' }
                : { eventDate: 'desc' },
        }),
        this.prisma.workshopReservation.findMany({
          where: reservationWhere,
          include: { workshop: true },
          orderBy:
            sort === 'name_asc'
              ? { workshop: { title: 'asc' } }
              : sort === 'date_asc'
                ? { workshop: { eventDate: 'asc' } }
                : sort === 'status'
                  ? { status: 'asc' }
                  : { workshop: { eventDate: 'desc' } },
        }),
        this.prisma.workshopReservation.count(),
        this.prisma.workshopReservation.count({
          where: { workshop: { eventDate: { gte: todayStart, lte: todayEnd } } },
        }),
        this.prisma.workshopReservation.count({ where: { status: WorkshopReservationStatus.VALIDEE } }),
        this.prisma.workshopReservation.count({ where: { status: WorkshopReservationStatus.EN_ATTENTE } }),
        this.prisma.workshopReservation.count({ where: { status: WorkshopReservationStatus.ANNULEE } }),
      ]);

    const pct = (n: number) => (totalReservations ? Math.round((n / totalReservations) * 100) : 0);

    return {
      stats: {
        total: totalReservations,
        today: todayCount,
        validated: validatedCount,
        pending: pendingCount,
        cancelled: cancelledCount,
        validatedPct: pct(validatedCount),
        pendingPct: pct(pendingCount),
        cancelledPct: pct(cancelledCount),
      },
      ateliers: workshops.map((w) => ({
        id: w.id,
        title: w.title,
        description: w.description ?? '',
        importantInfo: w.importantInfo ?? '',
        image: w.imageUrl,
        dateLabel: formatDateLongFr(w.eventDate),
        dateValue: w.eventDate.toISOString().slice(0, 10),
        timeLabel: formatTimeLabel(w.startTime, w.endTime),
        startTime: w.startTime,
        endTime: w.endTime,
        location: w.location ?? '',
        ageLabel: w.ageRange || w.recommendedAge || '—',
        ageRange: w.ageRange ?? '',
        recommendedAge: w.recommendedAge ?? '',
        priceLabel: w.isFree ? 'Gratuit' : w.priceLabel || '—',
        isFree: w.isFree,
        capacity: w.capacity,
        booked: w._count.reservations,
        published: w.published,
      })),
      reservations: reservations.map((r) => ({
        id: r.id,
        code: r.code,
        atelierTitle: r.workshop.title,
        atelierSubtitle: r.workshop.description ?? '',
        atelierImage: r.workshop.imageUrl,
        childName: r.childName,
        childAge: r.childAge ?? 0,
        parentName: r.parentName,
        parentPhone: r.parentPhone ?? '',
        sessionLabel: formatSessionLabel(r.workshop.eventDate, r.workshop.startTime, r.workshop.endTime),
        sessionDate: r.workshop.eventDate.toISOString().slice(0, 10),
        places: `${r.places}/${r.places}`,
        ageRange: r.workshop.ageRange || r.workshop.recommendedAge || '—',
        status: r.status,
        reservedAt: formatReservedAt(r.reservedAt),
      })),
    };
  }

  async create(body: Record<string, unknown>) {
    const title = parseRequiredString(body.title, "Le titre de l'atelier");
    const description = parseRequiredString(body.description, 'La description');
    const importantInfo = parseOptionalString(body.importantInfo);
    const imageUrl = parseRequiredString(body.imageUrl, "L'image de l'atelier");
    const eventDate = parseEventDate(body.date ?? body.eventDate);
    const startTime = parseRequiredString(body.startTime, "L'heure de début");
    const endTime = parseRequiredString(body.endTime, "L'heure de fin");
    const location = parseRequiredString(body.location, 'Le lieu');
    const ageRange = parseRequiredString(body.ageRange, "La tranche d'âge");
    const recommendedAge = parseRequiredString(body.recommendedAge, "L'âge recommandé");
    const capacity = parseCapacity(body.capacity);
    const isFree = parseBool(body.isFree, true);
    const priceLabel = isFree ? null : parseRequiredString(body.price ?? body.priceLabel, "Le prix de l'atelier");
    const published = parseBool(body.published, true);

    return this.prisma.workshop.create({
      data: {
        title,
        description,
        importantInfo,
        imageUrl,
        eventDate,
        startTime,
        endTime,
        location,
        ageRange,
        recommendedAge,
        capacity,
        isFree,
        priceLabel,
        published,
      },
    });
  }

  async update(id: string, body: Record<string, unknown>) {
    const existing = await this.prisma.workshop.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Atelier introuvable.');

    const title = parseRequiredString(body.title, "Le titre de l'atelier");
    const description = parseRequiredString(body.description, 'La description');
    const importantInfo = parseOptionalString(body.importantInfo);
    const imageFromBody = parseOptionalString(body.imageUrl);
    const imageUrl = imageFromBody || existing.imageUrl;
    const eventDate = parseEventDate(body.date ?? body.eventDate);
    const startTime = parseRequiredString(body.startTime, "L'heure de début");
    const endTime = parseRequiredString(body.endTime, "L'heure de fin");
    const location = parseRequiredString(body.location, 'Le lieu');
    const ageRange = parseRequiredString(body.ageRange, "La tranche d'âge");
    const recommendedAge = parseRequiredString(body.recommendedAge, "L'âge recommandé");
    const capacity = parseCapacity(body.capacity);
    const isFree = parseBool(body.isFree, true);
    const priceLabel = isFree ? null : parseRequiredString(body.price ?? body.priceLabel, "Le prix de l'atelier");
    const published =
      body.published === undefined || body.published === null
        ? existing.published
        : parseBool(body.published, existing.published);

    return this.prisma.workshop.update({
      where: { id },
      data: {
        title,
        description,
        importantInfo,
        imageUrl,
        eventDate,
        startTime,
        endTime,
        location,
        ageRange,
        recommendedAge,
        capacity,
        isFree,
        priceLabel,
        published,
      },
    });
  }

  async setPublished(id: string, body: Record<string, unknown>) {
    const published = parseBool(body.published, false);
    try {
      return await this.prisma.workshop.update({
        where: { id },
        data: { published },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Atelier introuvable.');
      }
      throw e;
    }
  }

  async createReservation(body: Record<string, unknown>) {
    const workshopId = parseRequiredString(body.workshopId, "L'atelier");
    const workshop = await this.prisma.workshop.findUnique({ where: { id: workshopId } });
    if (!workshop) throw new NotFoundException('Atelier introuvable.');

    const childName = parseRequiredString(body.childName, "Le nom de l'enfant");
    const parentName = parseRequiredString(body.parentName, 'Le nom du parent');
    const parentPhone = parseOptionalString(body.parentPhone);
    const childAgeRaw = body.childAge;
    const childAge =
      childAgeRaw === undefined || childAgeRaw === null || String(childAgeRaw).trim() === ''
        ? null
        : Math.max(0, Math.floor(Number(childAgeRaw)));
    if (childAge !== null && !Number.isFinite(childAge)) {
      throw new BadRequestException("L'âge de l'enfant est invalide.");
    }
    const places = Math.max(1, Math.floor(Number(body.places ?? 1)) || 1);
    const status = body.status ? parseStatus(body.status) : WorkshopReservationStatus.EN_ATTENTE;
    const code = await this.nextReservationCode();

    return this.prisma.workshopReservation.create({
      data: {
        code,
        workshopId,
        childName,
        childAge,
        parentName,
        parentPhone,
        places,
        status,
      },
    });
  }

  async updateReservationStatus(id: string, body: Record<string, unknown>) {
    const status = parseStatus(body.status);
    try {
      return await this.prisma.workshopReservation.update({
        where: { id },
        data: { status },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Réservation introuvable.');
      }
      throw e;
    }
  }

  async remove(id: string) {
    try {
      await this.prisma.workshop.delete({ where: { id } });
      return { ok: true };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Atelier introuvable.');
      }
      throw e;
    }
  }
}
