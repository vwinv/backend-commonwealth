import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  DocumentKind,
  DocumentSignatureStatus,
  EnrollmentStatus,
  Prisma,
  UserRole,
} from '@prisma/client';
import {
  audienceLabelParts,
  documentAudienceParentWhere,
  type DocumentAudienceRefs,
} from '../documents/document-audience.util';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

function kindLabelFr(k: DocumentKind): string {
  return k === DocumentKind.ADMIN ? 'Administratif' : 'Scolaire';
}

function parseIdList(body: Record<string, unknown>, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const raw = body?.[key];
    if (Array.isArray(raw)) {
      out.push(...raw.map((x) => String(x ?? '').trim()).filter(Boolean));
    } else if (typeof raw === 'string' && raw.trim()) {
      out.push(raw.trim());
    }
  }
  return [...new Set(out)];
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
          levels: { include: { level: true } },
          classes: { include: { class: { include: { level: true } } } },
          targetedParents: {
            include: { parent: { select: { id: true, fullName: true, email: true } } },
          },
          _count: { select: { signatures: true } },
          signatures: { select: { status: true } },
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
      items: rows.map((d) => {
        const signedCount = d.signatures.filter((s) => s.status === DocumentSignatureStatus.SIGNED)
          .length;
        const pendingCount = d.signatures.filter((s) => s.status === DocumentSignatureStatus.PENDING)
          .length;
        const levelLabels = d.levels
          .map((ld) => ld.level.name)
          .sort((a, b) => a.localeCompare(b, 'fr'));
        const classLabels = d.classes
          .map((cd) => `${cd.class.level.name} · ${cd.class.name}`)
          .sort((a, b) => a.localeCompare(b, 'fr'));
        const parentNames = d.targetedParents
          .map((tp) => tp.parent.fullName?.trim() || tp.parent.email)
          .sort((a, b) => a.localeCompare(b, 'fr'));
        return {
          id: d.id,
          title: d.title,
          url: d.url,
          kind: d.kind,
          kindLabel: kindLabelFr(d.kind),
          published: d.published,
          requiresParentSignature: d.requiresParentSignature,
          signaturesPending: pendingCount,
          signaturesSigned: signedCount,
          signaturesTotal: d._count.signatures,
          dateLabel: formatDateFr(d.createdAt),
          levelLabels,
          classLabels,
          parentLabels: parentNames,
          audienceLabels: audienceLabelParts({
            levelNames: levelLabels,
            classLabels,
            parentNames,
          }),
        };
      }),
      total,
      page,
      limit,
    };
  }

  async searchParentOptions(search?: string) {
    const q = search?.trim();
    const where: Prisma.UserWhereInput = {
      role: UserRole.PARENT,
      blocked: false,
      ...(q
        ? {
            OR: [
              { fullName: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.user.findMany({
      where,
      orderBy: [{ fullName: 'asc' }, { email: 'asc' }],
      take: 30,
      select: {
        id: true,
        fullName: true,
        email: true,
        children: {
          select: {
            firstName: true,
            lastName: true,
            enrollments: {
              where: { status: EnrollmentStatus.APPROVED },
              select: {
                level: { select: { name: true } },
                class: { select: { name: true } },
              },
              take: 3,
            },
          },
          take: 3,
        },
      },
    });
    return {
      items: rows.map((u) => ({
        id: u.id,
        fullName: u.fullName?.trim() || u.email,
        email: u.email,
        hint: u.children
          .map((c) => {
            const name = [c.firstName, c.lastName].filter(Boolean).join(' ');
            const ctx = c.enrollments
              .map((e) => [e.level.name, e.class?.name].filter(Boolean).join(' · '))
              .filter(Boolean)
              .join(', ');
            return ctx ? `${name} (${ctx})` : name;
          })
          .filter(Boolean)
          .join(' · '),
      })),
    };
  }

  async getAudienceOptions() {
    const levels = await this.prisma.level.findMany({
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        classes: {
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        },
      },
    });
    return {
      levels: levels.map((l) => ({
        id: l.id,
        name: l.name,
        classes: l.classes.map((c) => ({ id: c.id, name: c.name })),
      })),
    };
  }

  async create(body: Record<string, unknown>) {
    const title = String(body?.title ?? '').trim();
    const url = String(body?.url ?? '').trim();
    const kindRaw = String(body?.kind ?? 'SCHOOL').toUpperCase();
    const kind = kindRaw === 'ADMIN' ? DocumentKind.ADMIN : DocumentKind.SCHOOL;
    const levelIds = parseIdList(body, ['levelIds', 'levelId']);
    const classIds = parseIdList(body, ['classIds', 'classId']);
    const parentIds = parseIdList(body, ['parentIds', 'parentId']);
    const requiresParentSignature =
      body?.requiresParentSignature === true || body?.requiresParentSignature === 'true';

    if (!title) throw new BadRequestException('Le titre est obligatoire');
    if (!url) throw new BadRequestException('L’URL ou le fichier est obligatoire');

    await this.assertAudienceIds({ levelIds, classIds, parentIds });

    const published = body?.published !== false && body?.published !== 'false';

    const doc = await this.prisma.$transaction(async (tx) => {
      const created = await tx.document.create({
        data: { title, url, kind, published, requiresParentSignature },
      });
      if (levelIds.length > 0) {
        await tx.levelDocument.createMany({
          data: levelIds.map((levelId) => ({ levelId, documentId: created.id })),
          skipDuplicates: true,
        });
      }
      if (classIds.length > 0) {
        await tx.classDocument.createMany({
          data: classIds.map((classId) => ({ classId, documentId: created.id })),
          skipDuplicates: true,
        });
      }
      if (parentIds.length > 0) {
        await tx.documentParent.createMany({
          data: parentIds.map((parentId) => ({ parentId, documentId: created.id })),
          skipDuplicates: true,
        });
      }
      return created;
    });
    if (published) {
      if (requiresParentSignature) {
        await this.ensurePendingSignatures(doc.id).catch(() => undefined);
      }
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
        if (row.requiresParentSignature) {
          await this.ensurePendingSignatures(id).catch(() => undefined);
        }
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

  async getSignatures(
    id: string,
    query: { status?: string; search?: string; page?: number; limit?: number },
  ) {
    const doc = await this.prisma.document.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        url: true,
        kind: true,
        published: true,
        requiresParentSignature: true,
      },
    });
    if (!doc) throw new NotFoundException('Document introuvable');

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const search = query.search?.trim();
    const statusRaw = String(query.status ?? '').toUpperCase();
    const statusFilter =
      statusRaw === 'SIGNED'
        ? DocumentSignatureStatus.SIGNED
        : statusRaw === 'PENDING'
          ? DocumentSignatureStatus.PENDING
          : undefined;

    if (doc.requiresParentSignature && doc.published) {
      await this.ensurePendingSignatures(id).catch(() => undefined);
    }

    const where: Prisma.DocumentSignatureWhereInput = {
      documentId: id,
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(search
        ? {
            parent: {
              OR: [
                { fullName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };

    const [total, pendingCount, signedCount, rows] = await Promise.all([
      this.prisma.documentSignature.count({ where }),
      this.prisma.documentSignature.count({
        where: { documentId: id, status: DocumentSignatureStatus.PENDING },
      }),
      this.prisma.documentSignature.count({
        where: { documentId: id, status: DocumentSignatureStatus.SIGNED },
      }),
      this.prisma.documentSignature.findMany({
        where,
        orderBy: [{ status: 'asc' }, { signedAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          parent: {
            select: {
              id: true,
              fullName: true,
              email: true,
              children: {
                select: {
                  firstName: true,
                  lastName: true,
                  enrollments: {
                    where: { status: EnrollmentStatus.APPROVED },
                    select: { level: { select: { name: true } } },
                  },
                },
              },
            },
          },
        },
      }),
    ]);

    return {
      document: {
        id: doc.id,
        title: doc.title,
        url: doc.url,
        kind: doc.kind,
        kindLabel: kindLabelFr(doc.kind),
        published: doc.published,
        requiresParentSignature: doc.requiresParentSignature,
      },
      stats: {
        pending: pendingCount,
        signed: signedCount,
        total: pendingCount + signedCount,
      },
      items: rows.map((s) => ({
        id: s.id,
        status: s.status,
        statusLabel: s.status === DocumentSignatureStatus.SIGNED ? 'Signé' : 'À signer',
        signatureUrl: s.signatureUrl,
        signedAt: s.signedAt?.toISOString() ?? null,
        signedAtLabel: s.signedAt ? formatDateTimeFr(s.signedAt) : null,
        createdAt: s.createdAt.toISOString(),
        parent: {
          id: s.parent.id,
          fullName: s.parent.fullName || s.parent.email,
          email: s.parent.email,
          childrenLabels: s.parent.children
            .map((c) => {
              const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Enfant';
              const levels = [
                ...new Set(c.enrollments.map((e) => e.level.name).filter(Boolean)),
              ].join(', ');
              return levels ? `${name} (${levels})` : name;
            })
            .sort((a, b) => a.localeCompare(b, 'fr')),
        },
      })),
      total,
      page,
      limit,
    };
  }

  async loadAudience(documentId: string): Promise<DocumentAudienceRefs | null> {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: {
        levels: { select: { levelId: true } },
        classes: { select: { classId: true } },
        targetedParents: { select: { parentId: true } },
      },
    });
    if (!doc) return null;
    return {
      levelIds: doc.levels.map((l) => l.levelId),
      classIds: doc.classes.map((c) => c.classId),
      parentIds: doc.targetedParents.map((p) => p.parentId),
    };
  }

  async ensurePendingSignatures(documentId: string) {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { published: true, requiresParentSignature: true },
    });
    if (!doc?.published || !doc.requiresParentSignature) return { created: 0 };

    const audience = await this.loadAudience(documentId);
    if (!audience) return { created: 0 };

    const parents = await this.prisma.user.findMany({
      where: documentAudienceParentWhere(audience),
      select: { id: true },
    });

    if (!parents.length) return { created: 0 };

    const result = await this.prisma.documentSignature.createMany({
      data: parents.map((p) => ({
        documentId,
        parentId: p.id,
        status: DocumentSignatureStatus.PENDING,
      })),
      skipDuplicates: true,
    });
    return { created: result.count };
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

  private async assertAudienceIds(a: DocumentAudienceRefs) {
    if (a.levelIds.length > 0) {
      const levels = await this.prisma.level.findMany({
        where: { id: { in: a.levelIds } },
        select: { id: true },
      });
      if (levels.length !== a.levelIds.length) {
        throw new BadRequestException('Un ou plusieurs niveaux sont invalides.');
      }
    }
    if (a.classIds.length > 0) {
      const classes = await this.prisma.classRoom.findMany({
        where: { id: { in: a.classIds } },
        select: { id: true },
      });
      if (classes.length !== a.classIds.length) {
        throw new BadRequestException('Une ou plusieurs classes sont invalides.');
      }
    }
    if (a.parentIds.length > 0) {
      const parents = await this.prisma.user.findMany({
        where: { id: { in: a.parentIds }, role: UserRole.PARENT },
        select: { id: true },
      });
      if (parents.length !== a.parentIds.length) {
        throw new BadRequestException('Un ou plusieurs parents sont invalides.');
      }
    }
  }
}

function formatDateFr(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function formatDateTimeFr(d: Date): string {
  const date = formatDateFr(d);
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${date} ${hh}:${min}`;
}
