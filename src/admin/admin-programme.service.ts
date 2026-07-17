import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProgramEventStatus, SchoolYearStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const DAY_ABBR_FR = ['DIM', 'LUN', 'MAR', 'MER', 'JEU', 'VEN', 'SAM'] as const;

const COLOR_PALETTE = [
  { color: '#43A047', bgColor: '#E8F5E9' },
  { color: '#F9994B', bgColor: '#FFF3E0' },
  { color: '#7E57C2', bgColor: '#EDE7F6' },
  { color: '#AB47BC', bgColor: '#F3E5F5' },
  { color: '#216EC2', bgColor: '#E8F1FB' },
  { color: '#0D9488', bgColor: '#CCFBF1' },
  { color: '#DC2626', bgColor: '#FEE2E2' },
  { color: '#CA8A04', bgColor: '#FEF9C3' },
] as const;

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

function slugify(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return base || `CAT_${Date.now()}`;
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

  private mapCategory(c: {
    id: string;
    name: string;
    slug: string;
    color: string;
    bgColor: string;
    sortOrder: number;
    active: boolean;
  }) {
    return {
      id: c.id,
      name: c.name,
      slug: c.slug,
      color: c.color,
      bgColor: c.bgColor,
      sortOrder: c.sortOrder,
      active: c.active,
    };
  }

  async listCategories(includeInactive = false) {
    const rows = await this.prisma.programmeCategory.findMany({
      where: includeInactive ? undefined : { active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map((c) => this.mapCategory(c));
  }

  async createCategory(body: Record<string, unknown>) {
    const name = String(body?.name ?? '').trim();
    if (!name) throw new BadRequestException('Le nom de la catégorie est obligatoire.');

    const count = await this.prisma.programmeCategory.count();
    const palette = COLOR_PALETTE[count % COLOR_PALETTE.length];
    const color = String(body?.color ?? '').trim() || palette.color;
    const bgColor = String(body?.bgColor ?? '').trim() || palette.bgColor;
    let slug = slugify(String(body?.slug ?? name));

    const existingSlug = await this.prisma.programmeCategory.findUnique({ where: { slug } });
    if (existingSlug) slug = `${slug}_${Date.now().toString(36).toUpperCase()}`;

    try {
      const created = await this.prisma.programmeCategory.create({
        data: {
          name,
          slug,
          color,
          bgColor,
          sortOrder: count + 1,
          active: true,
        },
      });
      return this.mapCategory(created);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Une catégorie avec ce nom existe déjà.');
      }
      throw e;
    }
  }

  async updateCategory(id: string, body: Record<string, unknown>) {
    const existing = await this.prisma.programmeCategory.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Catégorie introuvable.');

    const data: Prisma.ProgrammeCategoryUpdateInput = {};
    if (body?.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw new BadRequestException('Le nom de la catégorie est obligatoire.');
      data.name = name;
    }
    if (body?.color !== undefined) data.color = String(body.color).trim() || existing.color;
    if (body?.bgColor !== undefined) data.bgColor = String(body.bgColor).trim() || existing.bgColor;
    if (body?.active !== undefined) {
      data.active = body.active === true || body.active === 'true' || body.active === 1 || body.active === '1';
    }
    if (body?.sortOrder !== undefined) {
      const n = Number(body.sortOrder);
      if (Number.isFinite(n)) data.sortOrder = Math.floor(n);
    }

    try {
      const updated = await this.prisma.programmeCategory.update({ where: { id }, data });
      return this.mapCategory(updated);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Une catégorie avec ce nom existe déjà.');
      }
      throw e;
    }
  }

  async removeCategory(id: string) {
    const existing = await this.prisma.programmeCategory.findUnique({
      where: { id },
      include: { _count: { select: { events: true } } },
    });
    if (!existing) throw new NotFoundException('Catégorie introuvable.');
    if (existing._count.events > 0) {
      throw new BadRequestException(
        'Impossible de supprimer cette catégorie : des programmes y sont encore liés. Désactivez-la plutôt.',
      );
    }
    await this.prisma.programmeCategory.delete({ where: { id } });
    return { ok: true };
  }

  private async resolveCategoryId(raw: unknown): Promise<string> {
    const value = String(raw ?? '').trim();
    if (!value) throw new BadRequestException('La catégorie est obligatoire.');

    const byId = await this.prisma.programmeCategory.findFirst({
      where: { OR: [{ id: value }, { slug: value.toUpperCase() }], active: true },
    });
    if (byId) return byId.id;

    throw new BadRequestException('Catégorie invalide.');
  }

  async getOverview(query: { schoolYear?: string; category?: string }) {
    const schoolYear = await this.resolveSchoolYear(query.schoolYear);
    const categoryRaw = String(query.category ?? '').trim();
    const categoryFilter =
      categoryRaw && categoryRaw !== 'ALL'
        ? await this.prisma.programmeCategory.findFirst({
            where: { OR: [{ id: categoryRaw }, { slug: categoryRaw.toUpperCase() }] },
          })
        : null;

    const where: Prisma.ProgramEventWhereInput = {
      schoolYear,
      ...(categoryFilter ? { categoryId: categoryFilter.id } : {}),
    };

    const [rows, staffOptions, categories] = await Promise.all([
      this.prisma.programEvent.findMany({
        where,
        orderBy: { eventDate: 'asc' },
        include: {
          levels: { include: { level: true } },
          category: true,
        },
      }),
      this.listStaffOptions(),
      this.listCategories(true),
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
        categoryId: row.categoryId,
        category: row.categoryId,
        categoryLabel: row.category.name,
        categoryColor: row.category.color,
        categoryBgColor: row.category.bgColor,
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
      categories,
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
    const categoryId = await this.resolveCategoryId(body?.categoryId ?? body?.category);
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
          categoryId,
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
    if (body?.categoryId !== undefined || body?.category !== undefined) {
      const categoryId = await this.resolveCategoryId(body?.categoryId ?? body?.category);
      data.category = { connect: { id: categoryId } };
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

    const eventDate = data.eventDate instanceof Date ? data.eventDate : existing.eventDate;
    const endDate = data.endDate !== undefined ? (data.endDate as Date | null) : existing.endDate;
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
