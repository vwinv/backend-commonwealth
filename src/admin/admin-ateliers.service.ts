import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole, WorkshopAccountKind, WorkshopReservationStatus } from '@prisma/client';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import {
  formatDateRangeLongFr,
  formatDateRangeShortFr,
  isoDateKey,
  parseEventDate,
  resolveWorkshopDates,
  workshopEnd,
} from '../workshops/workshop-date.util';

function parseRequiredString(raw: unknown, label: string): string {
  const s = String(raw ?? '').trim();
  if (!s) throw new BadRequestException(`${label} est obligatoire.`);
  return s;
}

function parseOptionalString(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  return s || null;
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

function formatTimeLabel(start: string, end: string): string {
  const fmt = (t: string) => t.replace(':', 'H');
  return `${fmt(start)} à ${fmt(end)}`;
}

function formatSessionLabel(start: Date, end: Date, startTime: string, endTime: string): string {
  return `${formatDateRangeShortFr(start, end)}, ${startTime} - ${endTime}`;
}

function workshopDateFields(w: { eventDate: Date; endDate?: Date | null; startTime: string; endTime: string }) {
  const end = workshopEnd(w);
  const dateLabel = formatDateRangeLongFr(w.eventDate, end);
  return {
    date: dateLabel,
    dateLabel,
    dateValue: isoDateKey(w.eventDate),
    endDateValue: isoDateKey(end),
    time: `De ${formatTimeLabel(w.startTime, w.endTime)}`,
    startTime: w.startTime,
    endTime: w.endTime,
  };
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

function formatReservedParts(d: Date) {
  return {
    reservedAtDate: d.toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }),
    reservedAtTime: d.toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
    }),
  };
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
  private readonly logger = new Logger(AdminAteliersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  private async nextReservationCode(): Promise<string> {
    const count = await this.prisma.workshopReservation.count();
    return `RES-${String(count + 1).padStart(5, '0')}`;
  }

  async listPublished() {
    const today = startOfToday();
    const workshops = await this.prisma.workshop.findMany({
      where: {
        published: true,
        endDate: { gte: today },
      },
      orderBy: [{ eventDate: 'asc' }, { startTime: 'asc' }],
    });

    const ids = workshops.map((w) => w.id);
    const bookedRows = ids.length
      ? await this.prisma.workshopReservation.groupBy({
          by: ['workshopId'],
          where: {
            workshopId: { in: ids },
            status: { not: WorkshopReservationStatus.ANNULEE },
          },
          _sum: { places: true },
        })
      : [];
    const bookedMap = new Map(bookedRows.map((r) => [r.workshopId, r._sum.places ?? 0]));

    return {
      items: workshops.map((w) => {
        const used = bookedMap.get(w.id) ?? 0;
        const closed = Boolean(w.closed);
        return {
          id: w.id,
          title: w.title,
          description: w.description ?? '',
          image: w.imageUrl,
          ...workshopDateFields(w),
          age: w.ageRange || w.recommendedAge || '—',
          price: w.isFree ? 'Gratuit' : w.priceLabel || '—',
          location: w.location ?? '',
          capacity: w.capacity,
          closed,
          placesRemaining: closed ? 0 : Math.max(0, w.capacity - used),
        };
      }),
    };
  }

  async getPublishedById(id: string) {
    const workshop = await this.prisma.workshop.findFirst({
      where: { id, published: true },
    });
    if (!workshop) throw new NotFoundException('Atelier introuvable.');

    const booked = await this.prisma.workshopReservation.aggregate({
      where: {
        workshopId: id,
        status: { not: WorkshopReservationStatus.ANNULEE },
      },
      _sum: { places: true },
    });
    const placesUsed = booked._sum.places ?? 0;
    const closed = Boolean(workshop.closed);
    const placesRemaining = closed ? 0 : Math.max(0, workshop.capacity - placesUsed);

    return {
      id: workshop.id,
      title: workshop.title,
      description: workshop.description ?? '',
      importantInfo: workshop.importantInfo ?? '',
      image: workshop.imageUrl,
      ...workshopDateFields(workshop),
      age: workshop.ageRange || workshop.recommendedAge || '—',
      price: workshop.isFree ? 'Gratuit' : workshop.priceLabel || '—',
      location: workshop.location ?? '',
      capacity: workshop.capacity,
      closed,
      placesRemaining,
    };
  }

  /**
   * Réservation depuis la landing :
   * - e-mail ou téléphone déjà PARENT → réservation liée à ce compte parent
   * - sinon → compte VISITEUR (données uniquement) + réservation
   */
  async registerFromPublic(workshopId: string, body: Record<string, unknown>) {
    const workshop = await this.prisma.workshop.findFirst({
      where: { id: workshopId, published: true },
    });
    if (!workshop) throw new NotFoundException('Atelier introuvable.');
    if (workshop.closed) {
      throw new BadRequestException('Cet atelier est clôturé : plus aucune réservation n’est possible.');
    }
    if (isoDateKey(workshopEnd(workshop)) < isoDateKey(startOfToday())) {
      throw new BadRequestException('Cet atelier est terminé : plus aucune réservation n’est possible.');
    }

    const fullName = parseRequiredString(body.fullName ?? body.parentName, 'Le nom');
    const email = parseRequiredString(body.email, "L'e-mail").toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('Adresse e-mail invalide.');
    }
    const phone = parseRequiredString(body.phone ?? body.parentPhone, 'Le téléphone');
    const places = Math.max(1, Math.floor(Number(body.places ?? 1)) || 1);

    const booked = await this.prisma.workshopReservation.aggregate({
      where: {
        workshopId,
        status: { not: WorkshopReservationStatus.ANNULEE },
      },
      _sum: { places: true },
    });
    const used = booked._sum.places ?? 0;
    if (used + places > workshop.capacity) {
      throw new BadRequestException('Il ne reste plus assez de places pour cet atelier.');
    }

    const normPhone = (p: string | null | undefined) =>
      String(p ?? '')
        .replace(/\D/g, '')
        .replace(/^221/, '');
    const phoneNorm = normPhone(phone);

    const byEmail = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        role: true,
        fullName: true,
        phone: true,
        email: true,
        blocked: true,
      },
    });

    if (byEmail?.role === UserRole.ADMIN || byEmail?.role === UserRole.STAFF) {
      throw new BadRequestException('Cette adresse e-mail ne peut pas être utilisée pour une réservation.');
    }

    // Recherche parent / visiteur par téléphone (même numéro, formats différents)
    let byPhone: typeof byEmail = null;
    if (phoneNorm.length >= 8) {
      const phoneCandidates = await this.prisma.user.findMany({
        where: {
          role: { in: [UserRole.PARENT, UserRole.VISITEUR] },
          phone: { not: null },
        },
        select: {
          id: true,
          role: true,
          fullName: true,
          phone: true,
          email: true,
          blocked: true,
        },
      });
      const matches = phoneCandidates.filter((u) => normPhone(u.phone) === phoneNorm);
      matches.sort((a, b) => (a.role === UserRole.PARENT ? 0 : 1) - (b.role === UserRole.PARENT ? 0 : 1));
      byPhone = matches[0] ?? null;
    }

    const parentByEmail = byEmail?.role === UserRole.PARENT ? byEmail : null;
    const parentByPhone = byPhone?.role === UserRole.PARENT ? byPhone : null;
    const visitorByEmail = byEmail?.role === UserRole.VISITEUR ? byEmail : null;
    const visitorByPhone = byPhone?.role === UserRole.VISITEUR ? byPhone : null;

    // Priorité : parent (e-mail puis téléphone), puis visiteur existant, sinon création visiteur
    const parentMatch = parentByEmail ?? parentByPhone;

    let accountKind: WorkshopAccountKind;
    let parentName: string;
    let parentPhone: string | null;
    let userId: string;

    if (parentMatch) {
      if (parentMatch.blocked) {
        throw new BadRequestException('Ce compte parent est désactivé. Contactez l’école.');
      }
      accountKind = WorkshopAccountKind.PARENT;
      userId = parentMatch.id;
      parentName = parentMatch.fullName?.trim() || parentMatch.email;
      parentPhone = phone || parentMatch.phone;
    } else if (visitorByEmail) {
      accountKind = WorkshopAccountKind.VISITEUR;
      userId = visitorByEmail.id;
      const updated = await this.prisma.user.update({
        where: { id: visitorByEmail.id },
        data: { fullName, phone },
        select: { fullName: true, phone: true, email: true },
      });
      parentName = updated.fullName?.trim() || updated.email;
      parentPhone = updated.phone;
    } else if (visitorByPhone) {
      accountKind = WorkshopAccountKind.VISITEUR;
      userId = visitorByPhone.id;
      const updated = await this.prisma.user.update({
        where: { id: visitorByPhone.id },
        data: { fullName, phone },
        select: { fullName: true, phone: true, email: true },
      });
      parentName = updated.fullName?.trim() || updated.email;
      parentPhone = updated.phone;
    } else {
      accountKind = WorkshopAccountKind.VISITEUR;
      const created = await this.prisma.user.create({
        data: {
          email,
          fullName,
          phone,
          role: UserRole.VISITEUR,
          passwordHash: null,
        },
        select: { id: true, fullName: true, phone: true, email: true },
      });
      userId = created.id;
      parentName = created.fullName?.trim() || created.email;
      parentPhone = created.phone;
    }

    const code = await this.nextReservationCode();
    const reservation = await this.prisma.workshopReservation.create({
      data: {
        code,
        workshopId,
        userId,
        childName: 'À préciser',
        childAge: null,
        parentName,
        parentPhone,
        places,
        status: WorkshopReservationStatus.EN_ATTENTE,
        accountKind,
      },
    });

    const dateLabel = formatDateRangeLongFr(workshop.eventDate, workshopEnd(workshop));
    const timeLabel = `De ${formatTimeLabel(workshop.startTime, workshop.endTime)}`;

    await this.mail
      .sendWorkshopReservationConfirmation({
        to: email,
        parentName,
        parentPhone,
        reservationCode: reservation.code,
        workshopTitle: workshop.title,
        workshopDateLabel: dateLabel,
        workshopTimeLabel: timeLabel,
        places,
        childName: null,
      })
      .catch((err) => {
        this.logger.error(
          `E-mail réservation atelier non envoyé (${reservation.code})`,
          err instanceof Error ? err.stack : err,
        );
      });

    return {
      id: reservation.id,
      code: reservation.code,
      status: reservation.status,
      workshopId,
      places,
      accountKind,
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

    const dateOverlap: Prisma.WorkshopWhereInput =
      dateFrom || dateTo
        ? {
            AND: [
              ...(dateTo ? [{ eventDate: { lte: new Date(`${dateTo}T23:59:59`) } }] : []),
              ...(dateFrom ? [{ endDate: { gte: new Date(`${dateFrom}T00:00:00`) } }] : []),
            ],
          }
        : {};

    const workshopWhere: Prisma.WorkshopWhereInput = {
      ...dateOverlap,
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
      ...(Object.keys(dateOverlap).length ? { workshop: dateOverlap } : {}),
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
          where: {
            workshop: {
              eventDate: { lte: todayEnd },
              endDate: { gte: todayStart },
            },
          },
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
        ...workshopDateFields(w),
        timeLabel: formatTimeLabel(w.startTime, w.endTime),
        location: w.location ?? '',
        ageLabel: w.ageRange || w.recommendedAge || '—',
        ageRange: w.ageRange ?? '',
        recommendedAge: w.recommendedAge ?? '',
        priceLabel: w.isFree ? 'Gratuit' : w.priceLabel || '—',
        isFree: w.isFree,
        capacity: w.capacity,
        booked: w._count.reservations,
        published: w.published,
        closed: w.closed,
      })),
      reservations: reservations.map((r) => {
        const reservedParts = formatReservedParts(r.reservedAt);
        return {
          id: r.id,
          code: r.code,
          atelierTitle: r.workshop.title,
          atelierSubtitle: r.workshop.description ?? '',
          atelierImage: r.workshop.imageUrl,
          childName: r.childName,
          childAge: r.childAge ?? 0,
          parentName: r.parentName,
          parentPhone: r.parentPhone ?? '',
          sessionLabel: formatSessionLabel(
            r.workshop.eventDate,
            workshopEnd(r.workshop),
            r.workshop.startTime,
            r.workshop.endTime,
          ),
          sessionDate: isoDateKey(r.workshop.eventDate),
          sessionEndDate: isoDateKey(workshopEnd(r.workshop)),
          sessionDateLabel: formatDateRangeShortFr(r.workshop.eventDate, workshopEnd(r.workshop)),
          sessionTimeLabel: `${r.workshop.startTime} - ${r.workshop.endTime}`,
          places: `${r.places}/${r.workshop.capacity}`,
          ageRange: r.workshop.ageRange || r.workshop.recommendedAge || '—',
          status: r.status,
          accountKind: r.accountKind,
          reservedAt: formatReservedAt(r.reservedAt),
          reservedAtDate: reservedParts.reservedAtDate,
          reservedAtTime: reservedParts.reservedAtTime,
        };
      }),
    };
  }

  async getById(id: string) {
    const workshop = await this.prisma.workshop.findUnique({
      where: { id },
      include: {
        reservations: { orderBy: { reservedAt: 'desc' } },
      },
    });
    if (!workshop) throw new NotFoundException('Atelier introuvable.');

    const confirmed = workshop.reservations.filter((r) => r.status === WorkshopReservationStatus.VALIDEE);
    const pending = workshop.reservations.filter((r) => r.status === WorkshopReservationStatus.EN_ATTENTE);
    const cancelled = workshop.reservations.filter((r) => r.status === WorkshopReservationStatus.ANNULEE);
    const sumPlaces = (rows: typeof workshop.reservations) => rows.reduce((acc, r) => acc + r.places, 0);
    const confirmedPlaces = sumPlaces(confirmed);
    const pendingPlaces = sumPlaces(pending);
    const cancelledPlaces = sumPlaces(cancelled);
    const booked = confirmedPlaces + pendingPlaces;
    const available = Math.max(0, workshop.capacity - booked);
    const pct = (n: number) => (workshop.capacity ? Math.round((n / workshop.capacity) * 100) : 0);

    return {
      atelier: {
        id: workshop.id,
        title: workshop.title,
        description: workshop.description ?? '',
        importantInfo: workshop.importantInfo ?? '',
        image: workshop.imageUrl,
        ...workshopDateFields(workshop),
        timeLabel: `De ${formatTimeLabel(workshop.startTime, workshop.endTime)}`,
        sessionLabel: formatSessionLabel(
          workshop.eventDate,
          workshopEnd(workshop),
          workshop.startTime,
          workshop.endTime,
        ),
        location: workshop.location ?? '',
        ageLabel: workshop.ageRange || workshop.recommendedAge || '—',
        ageRange: workshop.ageRange ?? '',
        recommendedAge: workshop.recommendedAge ?? '',
        priceLabel: workshop.isFree ? 'Gratuit' : workshop.priceLabel || '—',
        isFree: workshop.isFree,
        capacity: workshop.capacity,
        booked,
        published: workshop.published,
        closed: workshop.closed,
      },
      stats: {
        confirmed: confirmedPlaces,
        pending: pendingPlaces,
        cancelled: cancelledPlaces,
        available,
        booked,
        capacity: workshop.capacity,
        confirmedPct: pct(confirmedPlaces),
        pendingPct: pct(pendingPlaces),
        cancelledPct: pct(cancelledPlaces),
        availablePct: pct(available),
      },
      reservations: workshop.reservations.map((r) => ({
        id: r.id,
        code: r.code,
        childName: r.childName,
        childAge: r.childAge ?? 0,
        parentName: r.parentName,
        parentPhone: r.parentPhone ?? '',
        places: r.places,
        status: r.status,
        reservedAt: formatReservedAt(r.reservedAt),
      })),
    };
  }

  async duplicate(id: string) {
    const source = await this.prisma.workshop.findUnique({ where: { id } });
    if (!source) throw new NotFoundException('Atelier introuvable.');

    return this.prisma.workshop.create({
      data: {
        title: `${source.title} (copie)`,
        description: source.description,
        importantInfo: source.importantInfo,
        imageUrl: source.imageUrl,
        eventDate: source.eventDate,
        endDate: source.endDate,
        startTime: source.startTime,
        endTime: source.endTime,
        location: source.location,
        ageRange: source.ageRange,
        recommendedAge: source.recommendedAge,
        capacity: source.capacity,
        isFree: source.isFree,
        priceLabel: source.priceLabel,
        published: false,
        closed: false,
      },
    });
  }

  async create(body: Record<string, unknown>) {
    const title = parseRequiredString(body.title, "Le titre de l'atelier");
    const description = parseRequiredString(body.description, 'La description');
    const importantInfo = parseOptionalString(body.importantInfo);
    const imageUrl = parseRequiredString(body.imageUrl, "L'image de l'atelier");
    const startDate = parseEventDate(body.date ?? body.eventDate ?? body.startDate, 'La date de commencement');
    const { eventDate, endDate } = resolveWorkshopDates(startDate, body.endDate ?? body.dateEnd);
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
        endDate,
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
    const startDate = parseEventDate(body.date ?? body.eventDate ?? body.startDate, 'La date de commencement');
    const { eventDate, endDate } = resolveWorkshopDates(startDate, body.endDate ?? body.dateEnd);
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

    const updated = await this.prisma.workshop.update({
      where: { id },
      data: {
        title,
        description,
        importantInfo,
        imageUrl,
        eventDate,
        endDate,
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
    if (existing.imageUrl && existing.imageUrl !== imageUrl) {
      await this.cloudinary.destroyUrl(existing.imageUrl);
    }
    return updated;
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

  async setClosed(id: string, body: Record<string, unknown>) {
    const closed = parseBool(body.closed, true);
    try {
      return await this.prisma.workshop.update({
        where: { id },
        data: { closed },
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
    if (workshop.closed) {
      throw new BadRequestException('Cet atelier est clôturé : plus aucune réservation n’est possible.');
    }
    if (isoDateKey(workshopEnd(workshop)) < isoDateKey(startOfToday())) {
      throw new BadRequestException('Cet atelier est terminé : plus aucune réservation n’est possible.');
    }

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
        accountKind: WorkshopAccountKind.PARENT,
      },
    });
  }

  async updateReservationStatus(id: string, body: Record<string, unknown>) {
    const status = parseStatus(body.status);

    const existing = await this.prisma.workshopReservation.findUnique({
      where: { id },
      include: {
        workshop: true,
        user: { select: { email: true, fullName: true, phone: true } },
      },
    });
    if (!existing) throw new NotFoundException('Réservation introuvable.');

    const updated = await this.prisma.workshopReservation.update({
      where: { id },
      data: { status },
    });

    if (
      existing.status !== status &&
      (status === WorkshopReservationStatus.VALIDEE || status === WorkshopReservationStatus.ANNULEE)
    ) {
      const to =
        existing.user?.email?.trim() ||
        null;
      if (to) {
        const dateLabel = formatDateRangeLongFr(
          existing.workshop.eventDate,
          workshopEnd(existing.workshop),
        );
        const timeLabel = `De ${formatTimeLabel(existing.workshop.startTime, existing.workshop.endTime)}`;
        await this.mail
          .sendWorkshopReservationDecision({
            to,
            decision: status,
            parentName: existing.parentName || existing.user?.fullName || null,
            parentPhone: existing.parentPhone || existing.user?.phone || null,
            reservationCode: existing.code,
            workshopTitle: existing.workshop.title,
            workshopDateLabel: dateLabel,
            workshopTimeLabel: timeLabel,
            places: existing.places,
            childName: existing.childName === 'À préciser' ? null : existing.childName,
          })
          .catch((err) => {
            this.logger.error(
              `E-mail décision atelier non envoyé (${existing.code} → ${status})`,
              err instanceof Error ? err.stack : err,
            );
          });
      } else {
        this.logger.warn(
          `Pas d’e-mail pour la décision atelier ${existing.code} (${status}) : destinataire inconnu.`,
        );
      }
    }

    return updated;
  }

  async remove(id: string) {
    try {
      const existing = await this.prisma.workshop.delete({ where: { id } });
      await this.cloudinary.destroyUrl(existing.imageUrl);
      return { ok: true };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Atelier introuvable.');
      }
      throw e;
    }
  }
}
