import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DocumentKind, Prisma } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

function kindLabelFr(k: DocumentKind): string {
  return k === DocumentKind.ADMIN ? 'Administratif' : 'Scolaire';
}

@Injectable()
export class AdminDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async getOverview(query: { page?: number; limit?: number; search?: string; sort?: string }) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 10));
    const search = query.search?.trim();

    const where: Prisma.DocumentWhereInput = search
      ? { title: { contains: search, mode: 'insensitive' } }
      : {};

    const sort = query.sort?.trim() ?? 'date_desc';
    const orderBy: Prisma.DocumentOrderByWithRelationInput =
      sort === 'title_asc'
        ? { title: 'asc' }
        : sort === 'title_desc'
          ? { title: 'desc' }
          : sort === 'date_asc'
            ? { updatedAt: 'asc' }
            : sort === 'kind_asc'
              ? { kind: 'asc' }
              : { updatedAt: 'desc' };

    const [total, administratif, scolaire, rows] = await Promise.all([
      this.prisma.document.count({ where }),
      this.prisma.document.count({ where: { ...where, kind: DocumentKind.ADMIN } }),
      this.prisma.document.count({ where: { ...where, kind: DocumentKind.SCHOOL } }),
      this.prisma.document.findMany({
        where,
        orderBy,
        include: {
          levels: {
            include: { level: true },
          },
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      stats: {
        total,
        administratif,
        scolaire,
      },
      items: rows.map((d) => ({
        id: d.id,
        title: d.title,
        url: d.url,
        kind: d.kind,
        kindLabel: kindLabelFr(d.kind),
        published: d.published,
        dateLabel: formatDateFr(d.createdAt),
        levelLabels: d.levels.map((ld) => ld.level.name).sort((a, b) => a.localeCompare(b, 'fr')),
      })),
      total,
      page,
      limit,
    };
  }

  async create(body: Record<string, unknown>) {
    const title = String(body?.title ?? '').trim();
    const url = String(body?.url ?? '').trim();
    const kindRaw = String(body?.kind ?? 'SCHOOL').toUpperCase();
    const kind = kindRaw === 'ADMIN' ? DocumentKind.ADMIN : DocumentKind.SCHOOL;
    const singleLevelId = String(body?.levelId ?? '').trim();
    const fromArray = Array.isArray(body?.levelIds)
      ? body.levelIds.map((x) => String(x ?? '').trim()).filter(Boolean)
      : [];
    const levelIds = [...new Set([...fromArray, singleLevelId].filter(Boolean))];

    if (!title) throw new BadRequestException('Le titre est obligatoire');
    if (!url) throw new BadRequestException('L’URL ou le fichier est obligatoire');

    if (levelIds.length > 0) {
      const levels = await this.prisma.level.findMany({
        where: { id: { in: levelIds } },
        select: { id: true },
      });
      if (levels.length !== levelIds.length) {
        throw new BadRequestException('Un ou plusieurs niveaux sont invalides.');
      }
    }

    const published = body?.published === true;

    const doc = await this.prisma.$transaction(async (tx) => {
      const created = await tx.document.create({
        data: { title, url, kind, published },
      });
      if (levelIds.length > 0) {
        await tx.levelDocument.createMany({
          data: levelIds.map((levelId) => ({ levelId, documentId: created.id })),
          skipDuplicates: true,
        });
      }
      return created;
    });
    if (published) {
      await this.notifications.notifyDocumentPublished(doc.id).catch(() => undefined);
    }
    return doc;
  }

  async updatePublished(id: string, body: Record<string, unknown>) {
    if (body?.published === undefined) {
      throw new BadRequestException('published est requis');
    }
    const published = Boolean(body.published);
    try {
      const row = await this.prisma.document.update({
        where: { id },
        data: { published },
      });
      if (published) {
        await this.notifications.notifyDocumentPublished(id).catch(() => undefined);
      }
      return row;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Document introuvable');
      }
      throw e;
    }
  }

  async remove(id: string) {
    try {
      await this.prisma.document.delete({ where: { id } });
      return { ok: true };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Document introuvable');
      }
      throw e;
    }
  }
}

function formatDateFr(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}
