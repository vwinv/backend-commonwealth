import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  ProgramCategory,
  ProgramEventStatus,
  SchoolYearStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const CATEGORY_LABELS: Record<ProgramCategory, string> = {
  SORTIE_SCOLAIRE: 'Sortie scolaire',
  PARENTS: 'Parents',
  PROFESSEURS: 'Professeurs',
  SKILLS_EVEIL: 'Skills & éveil',
};

const DAY_ABBR_FR = ['DIM', 'LUN', 'MAR', 'MER', 'JEU', 'VEN', 'SAM'] as const;

function parseCategory(raw: string): ProgramCategory {
  const v = raw.trim().toUpperCase();
  if (v in ProgramCategory) return v as ProgramCategory;
  throw new BadRequestException('Catégorie invalide.');
}

function parseStatus(raw: string): ProgramEventStatus {
  const v = raw.trim().toUpperCase();
  if (v in ProgramEventStatus) return v as ProgramEventStatus;
  throw new BadRequestException('Statut invalide.');
}

function statusLabelFr(s: ProgramEventStatus): string {
  if (s === ProgramEventStatus.PLANNED) return 'Planifié';
  if (s === ProgramEventStatus.IN_PROGRESS) return 'En cours';
  return 'Terminé';
}

function formatDateFr(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function monthKeyFr(d: Date): string {
  const label = d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function parseEventDate(raw: unknown, label = 'La date'): Date {
  const s = String(raw ?? '').trim();
  if (!s) throw new BadRequestException(`${label} est obligatoire.`);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${label} invalide.`);
  return d;
}

function parseOptionalEventDate(raw: unknown): Date | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new BadRequestException('Date de fin invalide.');
  return d;
}

@Injectable()
export class AdminProgrammeService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveSchoolYear(schoolYear?: string): Promise<string> {
    const sy = String(schoolYear ?? '').trim();
    if (sy) return sy;
    const active = await this.prisma.schoolYear.findFirst({
      where: { status: SchoolYearStatus.OPEN },
      orderBy: { startDate: 'desc' },
    });
    if (active) return active.label;
    const latest = await this.prisma.schoolYear.findFirst({ orderBy: { startDate: 'desc' } });
    if (latest) return latest.label;
    const y = new Date().getFullYear();
    return `${y}-${y + 1}`;
  }

  private async listStaffOptions() {
    const users = await this.prisma.user.findMany({
      where: { role: { in: [UserRole.ADMIN, UserRole.STAFF] } },
      select: { id: true, fullName: true, email: true },
      orderBy: [{ fullName: 'asc' }, { email: 'asc' }],
    });
    return users.map((u) => ({
      id: u.id,
      label: (u.fullName?.trim() || u.email) ?? '—',
    }));
  }

  async getOverview(query: { schoolYear?: string; category?: string }) {
    const schoolYear = await this.resolveSchoolYear(query.schoolYear);
    const categoryRaw = query.category?.trim().toUpperCase();
    const categoryFilter =
      categoryRaw && categoryRaw !== 'ALL' && categoryRaw in ProgramCategory
        ? (categoryRaw as ProgramCategory)
        : undefined;

    const where: Prisma.ProgramEventWhereInput = {
      schoolYear,
      ...(categoryFilter ? { category: categoryFilter } : {}),
    };

    const [rows, staffOptions] = await Promise.all([
      this.prisma.programEvent.findMany({
        where,
        orderBy: { eventDate: 'asc' },
        include: {
          levels: { include: { level: true } },
        },
      }),
      this.listStaffOptions(),
    ]);

    let upcoming = 0;
    let inProgress = 0;
    let completed = 0;

    const items = rows.map((row) => {
      if (row.status === ProgramEventStatus.PLANNED) upcoming++;
      else if (row.status === ProgramEventStatus.IN_PROGRESS) inProgress++;
      else completed++;

      const dayNum = row.eventDate.getDate();
      const dayAbbr = DAY_ABBR_FR[row.eventDate.getDay()];
      const dateLabel = row.endDate
        ? `${formatDateFr(row.eventDate)} – ${formatDateFr(row.endDate)}`
        : formatDateFr(row.eventDate);

      return {
        id: row.id,
        title: row.title,
        description: row.description ?? '',
        eventDate: row.eventDate.toISOString(),
        endDate: row.endDate?.toISOString() ?? null,
        dateLabel,
        dayNum,
        dayAbbr,
        monthKey: monthKeyFr(row.eventDate),
        location: row.location ?? '',
        assignedStaff: row.assignedStaff ?? '',
        category: row.category,
        categoryLabel: CATEGORY_LABELS[row.category],
        status: row.status,
        statusLabel: statusLabelFr(row.status),
        levelLabels: row.levels.map((l) => l.level.name).sort((a, b) => a.localeCompare(b, 'fr')),
        levelIds: row.levels.map((l) => l.levelId),
      };
    });

    const groupsMap = new Map<string, typeof items>();
    for (const item of items) {
      const list = groupsMap.get(item.monthKey) ?? [];
      list.push(item);
      groupsMap.set(item.monthKey, list);
    }

    const groups = [...groupsMap.entries()].map(([monthLabel, events]) => ({
      monthLabel,
      events,
    }));

    return {
      schoolYear,
      staffOptions,
      stats: {
        total: rows.length,
        upcoming,
        inProgress,
        completed,
      },
      groups,
      items,
    };
  }

  async create(body: Record<string, unknown>) {
    const title = String(body?.title ?? '').trim();
    const description = String(body?.description ?? '').trim() || null;
    const location = String(body?.location ?? '').trim() || null;
    const assignedStaff = String(body?.assignedStaff ?? '').trim() || null;
    const category = parseCategory(String(body?.category ?? 'SORTIE_SCOLAIRE'));
    const status = parseStatus(String(body?.status ?? ProgramEventStatus.PLANNED));
    const schoolYear = await this.resolveSchoolYear(String(body?.schoolYear ?? ''));
    const eventDate = parseEventDate(body?.eventDate, 'La date de début');
    const endDate = parseOptionalEventDate(body?.endDate);
    if (endDate && endDate < eventDate) {
      throw new BadRequestException('La date de fin doit être postérieure ou égale à la date de début.');
    }

    if (!title) throw new BadRequestException('Le titre est obligatoire.');

    const levelIds = this.extractLevelIds(body);
    await this.validateLevelIds(levelIds);

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.programEvent.create({
        data: {
          title,
          description,
          eventDate,
          endDate,
          location,
          assignedStaff,
          category,
          status,
          schoolYear,
        },
      });
      if (levelIds.length > 0) {
        await tx.programEventLevel.createMany({
          data: levelIds.map((levelId) => ({ programEventId: created.id, levelId })),
        });
      }
      return created;
    });
  }

  async update(id: string, body: Record<string, unknown>) {
    const existing = await this.prisma.programEvent.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Programme introuvable.');

    const data: Prisma.ProgramEventUpdateInput = {};

    if (body?.title !== undefined) {
      const title = String(body.title).trim();
      if (!title) throw new BadRequestException('Le titre est obligatoire.');
      data.title = title;
    }
    if (body?.description !== undefined) {
      data.description = String(body.description).trim() || null;
    }
    if (body?.location !== undefined) {
      data.location = String(body.location).trim() || null;
    }
    if (body?.assignedStaff !== undefined) {
      data.assignedStaff = String(body.assignedStaff).trim() || null;
    }
    if (body?.category !== undefined) {
      data.category = parseCategory(String(body.category));
    }
    if (body?.status !== undefined) {
      data.status = parseStatus(String(body.status));
    }
    if (body?.eventDate !== undefined) {
      data.eventDate = parseEventDate(body.eventDate, 'La date de début');
    }
    if (body?.endDate !== undefined) {
      data.endDate = parseOptionalEventDate(body.endDate);
    }
    if (body?.schoolYear !== undefined) {
      data.schoolYear = await this.resolveSchoolYear(String(body.schoolYear));
    }

    const eventDate =
      data.eventDate instanceof Date ? data.eventDate : existing.eventDate;
    const endDate =
      data.endDate !== undefined
        ? (data.endDate as Date | null)
        : existing.endDate;
    if (endDate && endDate < eventDate) {
      throw new BadRequestException('La date de fin doit être postérieure ou égale à la date de début.');
    }

    const levelIds = body?.levelIds !== undefined ? this.extractLevelIds(body) : null;
    if (levelIds) await this.validateLevelIds(levelIds);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.programEvent.update({ where: { id }, data });
      if (levelIds) {
        await tx.programEventLevel.deleteMany({ where: { programEventId: id } });
        if (levelIds.length > 0) {
          await tx.programEventLevel.createMany({
            data: levelIds.map((levelId) => ({ programEventId: id, levelId })),
          });
        }
      }
      return updated;
    });
  }

  async remove(id: string) {
    try {
      await this.prisma.programEvent.delete({ where: { id } });
      return { ok: true };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Programme introuvable.');
      }
      throw e;
    }
  }

  private extractLevelIds(body: Record<string, unknown>): string[] {
    const fromArray = Array.isArray(body?.levelIds)
      ? body.levelIds.map((x) => String(x ?? '').trim()).filter(Boolean)
      : [];
    const single = String(body?.levelId ?? '').trim();
    return [...new Set([...fromArray, single].filter(Boolean))];
  }

  private async validateLevelIds(levelIds: string[]) {
    if (levelIds.length === 0) return;
    const levels = await this.prisma.level.findMany({
      where: { id: { in: levelIds } },
      select: { id: true },
    });
    if (levels.length !== levelIds.length) {
      throw new BadRequestException('Un ou plusieurs niveaux sont invalides.');
    }
  }
}
