import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EnrollmentStatus, ParentRelation, PaymentStatus, Prisma, UserRole } from '@prisma/client';
import { BillingService } from '../billing/billing.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminStudentsService } from './admin-students.service';

function parentRelationLabelFr(rel: ParentRelation | null | undefined): string {
  if (rel === ParentRelation.FATHER) return 'Père';
  if (rel === ParentRelation.MOTHER) return 'Mère';
  return '—';
}

@Injectable()
export class AdminParentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly students: AdminStudentsService,
    private readonly billing: BillingService,
  ) {}

  private paidApprovedEnrollmentWhere(): Prisma.EnrollmentWhereInput {
    return {
      status: EnrollmentStatus.APPROVED,
      OR: [
        { tuitionCharges: { some: { status: PaymentStatus.PAID } } },
        { monthlyInstallments: { some: { status: PaymentStatus.PAID } } },
        { payments: { some: { status: PaymentStatus.PAID } } },
      ],
    };
  }

  private parentListWhere(search?: string): Prisma.UserWhereInput {
    const base: Prisma.UserWhereInput = {
      role: UserRole.PARENT,
    };
    const q = search?.trim();
    if (!q) return base;
    return {
      ...base,
      AND: [
        {
          OR: [
            { fullName: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
            { phone: { contains: q, mode: 'insensitive' } },
          ],
        },
      ],
    };
  }

  /** Enfants avec au moins une inscription validée + payée (même règle que la liste élèves). */
  private async countEnrolledChildren(parentId: string): Promise<number> {
    return this.prisma.child.count({
      where: {
        parentId,
        enrollments: { some: this.paidApprovedEnrollmentWhere() },
      },
    });
  }

  async getOverview(query: { page?: number; limit?: number; search?: string; sort?: string }) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 10));
    const skip = (page - 1) * limit;
    const where = this.parentListWhere(query.search);

    const statsOverview = await this.students.getOverview({
      page: 1,
      limit: 1,
      search: undefined,
      sort: undefined,
    });

    let orderBy: Prisma.UserOrderByWithRelationInput | Prisma.UserOrderByWithRelationInput[] = {
      createdAt: 'desc',
    };
    const sort = query.sort?.trim();
    if (sort === 'date_asc') {
      orderBy = { createdAt: 'asc' };
    } else if (sort === 'name_asc') {
      orderBy = { fullName: 'asc' };
    } else if (sort === 'name_desc') {
      orderBy = { fullName: 'desc' };
    }

    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        select: {
          id: true,
          email: true,
          fullName: true,
          phone: true,
          parentRelation: true,
          blocked: true,
          monthlyPaymentPlanEnabled: true,
          createdAt: true,
          _count: { select: { children: true } },
          children: {
            where: {
              enrollments: {
                some: this.paidApprovedEnrollmentWhere(),
              },
            },
            select: { id: true },
          },
        },
      }),
    ]);

    return {
      stats: statsOverview.stats,
      items: rows.map((u) => ({
        id: u.id,
        fullName: u.fullName?.trim() || u.email,
        email: u.email,
        phone: u.phone,
        relationLabel: parentRelationLabelFr(u.parentRelation),
        /** Enfants « inscrits » au sens inscription validée + payée. */
        childrenCount: u.children.length,
        totalChildrenCount: u._count.children,
        blocked: u.blocked,
        monthlyPaymentPlanEnabled: u.monthlyPaymentPlanEnabled,
      })),
      total,
      page,
      limit,
    };
  }

  async getOne(parentId: string) {
    const u = await this.prisma.user.findFirst({
      where: {
        id: parentId,
        role: UserRole.PARENT,
      },
      include: {
        children: {
          include: {
            enrollments: {
              where: this.paidApprovedEnrollmentWhere(),
              take: 1,
              orderBy: { createdAt: 'desc' },
              include: {
                level: true,
                class: true,
              },
            },
          },
        },
      },
    });

    if (!u) {
      throw new NotFoundException('Parent introuvable');
    }

    return {
      id: u.id,
      email: u.email,
      fullName: u.fullName?.trim() || u.email,
      phone: u.phone,
      address: u.address,
      parentRelation: u.parentRelation,
      relationLabel: parentRelationLabelFr(u.parentRelation),
      blocked: u.blocked,
      monthlyPaymentPlanEnabled: u.monthlyPaymentPlanEnabled,
      createdAt: u.createdAt.toISOString(),
      children: u.children.map((c) => {
        const e = c.enrollments[0];
        return {
          childId: c.id,
          name: `${c.firstName} ${c.lastName}`.trim(),
          className: e ? e.class?.name ?? e.level.name : '—',
          schoolYear: e?.schoolYear ?? '—',
          canViewStudent: Boolean(e),
        };
      }),
    };
  }

  async setBlocked(parentId: string, blocked: boolean) {
    const u = await this.prisma.user.findFirst({
      where: { id: parentId, role: UserRole.PARENT },
    });
    if (!u) {
      throw new NotFoundException('Parent introuvable');
    }
    if (blocked) {
      const enrolled = await this.countEnrolledChildren(parentId);
      if (enrolled > 0) {
        throw new BadRequestException(
          'Impossible de bloquer ce compte tant qu’au moins un enfant est inscrit (inscription validée avec paiement).',
        );
      }
    }
    await this.prisma.user.update({
      where: { id: parentId },
      data: { blocked },
    });
    return { id: parentId, blocked };
  }

  async setMonthlyPaymentPlan(parentId: string, enabled: boolean) {
    const u = await this.prisma.user.findFirst({
      where: { id: parentId, role: UserRole.PARENT },
      select: { id: true },
    });
    if (!u) {
      throw new NotFoundException('Parent introuvable');
    }

    await this.prisma.user.update({
      where: { id: parentId },
      data: { monthlyPaymentPlanEnabled: enabled },
    });

    const billing = await this.billing.syncApprovedBillingForParent(parentId);

    return {
      id: parentId,
      monthlyPaymentPlanEnabled: enabled,
      enrollmentsUpdated: billing.enrollmentsUpdated,
    };
  }

  async remove(parentId: string) {
    const u = await this.prisma.user.findFirst({
      where: { id: parentId, role: UserRole.PARENT },
      include: { _count: { select: { children: true } } },
    });
    if (!u) {
      throw new NotFoundException('Parent introuvable');
    }
    const enrolled = await this.countEnrolledChildren(parentId);
    if (enrolled > 0) {
      throw new BadRequestException(
        'Impossible de supprimer ce parent tant qu’au moins un enfant est inscrit (inscription validée avec paiement).',
      );
    }
    if (u._count.children > 0) {
      throw new BadRequestException(
        'Impossible de supprimer un parent qui a des enfants rattachés. Retirez ou transférez les fiches enfants d’abord.',
      );
    }
    await this.prisma.user.delete({ where: { id: parentId } });
  }
}
