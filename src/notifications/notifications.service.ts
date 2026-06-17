import { Injectable } from '@nestjs/common';
import { EnrollmentStatus, PaymentStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  private async createIfNewChannel(
    userId: string,
    channel: string,
    data: { title: string; body: string; kind: string; enrollmentId?: string },
  ) {
    const existing = await this.prisma.notification.findFirst({
      where: { userId, channel },
    });
    if (existing) return existing;
    return this.prisma.notification.create({
      data: {
        userId,
        channel,
        title: data.title,
        body: data.body,
        kind: data.kind,
        enrollmentId: data.enrollmentId,
      },
    });
  }

  async notifyEnrollmentApproved(enrollmentId: string) {
    const e = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      include: { child: { select: { firstName: true, lastName: true, parentId: true } }, level: { select: { name: true } } },
    });
    const parentId = e?.child.parentId;
    if (!parentId || !e) return;
    const name = `${e.child.firstName} ${e.child.lastName}`.trim();
    await this.createIfNewChannel(parentId, `enrollment:approved:${enrollmentId}`, {
      title: 'Inscription acceptée',
      body: `L’inscription de ${name} (${e.level.name}) pour l’année ${e.schoolYear} a été validée.`,
      kind: 'ENROLLMENT_APPROVED',
      enrollmentId,
    });
  }

  async notifyEnrollmentRejected(enrollmentId: string) {
    const e = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      include: { child: { select: { firstName: true, lastName: true, parentId: true } }, level: { select: { name: true } } },
    });
    const parentId = e?.child.parentId;
    if (!parentId || !e) return;
    const name = `${e.child.firstName} ${e.child.lastName}`.trim();
    await this.createIfNewChannel(parentId, `enrollment:rejected:${enrollmentId}`, {
      title: 'Inscription refusée',
      body: `L’inscription de ${name} (${e.level.name}) pour l’année ${e.schoolYear} n’a pas été retenue.${e.validationNote ? ` Note : ${e.validationNote}` : ''}`,
      kind: 'ENROLLMENT_REJECTED',
      enrollmentId,
    });
  }

  async notifyDocumentPublished(documentId: string) {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: { levels: { select: { levelId: true } } },
    });
    if (!doc?.published) return;

    const levelIds = doc.levels.map((l) => l.levelId);
    const parents = await this.prisma.user.findMany({
      where: {
        role: UserRole.PARENT,
        blocked: false,
        children: {
          some: {
            enrollments: {
              some: {
                status: EnrollmentStatus.APPROVED,
                ...(levelIds.length > 0 ? { levelId: { in: levelIds } } : {}),
              },
            },
          },
        },
      },
      select: { id: true },
    });

    const kindLabel = doc.kind === 'ADMIN' ? 'administratif' : 'scolaire';
    for (const p of parents) {
      await this.createIfNewChannel(p.id, `doc:${documentId}`, {
        title: 'Nouveau document',
        body: `Un document ${kindLabel} a été publié : « ${doc.title} ».`,
        kind: 'DOCUMENT',
      });
    }
  }

  async notifyEmailSentToParentEmail(toEmail: string, subjectHint: string) {
    const email = toEmail.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, role: true },
    });
    if (!user || user.role !== UserRole.PARENT) return;
    await this.prisma.notification.create({
      data: {
        userId: user.id,
        title: 'Message de l’école',
        body: `Un e-mail vous a été envoyé${subjectHint ? ` (${subjectHint})` : ''}. Consultez votre boîte de réception.`,
        kind: 'EMAIL',
        channel: `email:${Date.now()}`,
      },
    });
  }

  async notifyHealthSignatureRequest(parentId: string, childId: string, childName: string) {
    await this.prisma.notification.create({
      data: {
        userId: parentId,
        channel: `health-signature:${childId}:${Date.now()}`,
        title: 'Signature fiche santé',
        body: `Merci de signer la fiche santé de ${childName} depuis votre espace parent.`,
        kind: 'HEALTH_SIGNATURE_REQUEST',
      },
    });
  }

  async ensureOverduePaymentNotifications(userId: string) {
    const children = await this.prisma.child.findMany({
      where: { parentId: userId },
      select: {
        id: true,
        enrollments: {
          where: { status: EnrollmentStatus.APPROVED },
          select: { id: true },
        },
      },
    });
    const enrollmentIds = [...new Set(children.flatMap((c) => c.enrollments.map((e) => e.id)))];
    if (enrollmentIds.length === 0) return;

    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const cutoffTuition = new Date(now);
    cutoffTuition.setDate(cutoffTuition.getDate() - 14);

    const tuitionRows = await this.prisma.tuitionCharge.findMany({
      where: {
        enrollmentId: { in: enrollmentIds },
        status: PaymentStatus.PENDING,
        amountCents: { gt: 0 },
        createdAt: { lt: cutoffTuition },
      },
      include: {
        enrollment: { select: { child: { select: { firstName: true, lastName: true } }, schoolYear: true } },
      },
    });

    for (const t of tuitionRows) {
      const ch = `overdue:tuition:${t.id}`;
      const exists = await this.prisma.notification.findFirst({ where: { userId, channel: ch } });
      if (exists) continue;
      const childName = `${t.enrollment.child.firstName} ${t.enrollment.child.lastName}`.trim();
      await this.prisma.notification.create({
        data: {
          userId,
          channel: ch,
          title: 'Paiement en retard — scolarité',
          body: `La scolarité annuelle pour ${childName} (${t.schoolYear}) est encore due. Merci de régulariser votre situation.`,
          kind: 'PAYMENT_OVERDUE',
          enrollmentId: t.enrollmentId,
        },
      });
    }

    const monthlyRows = await this.prisma.monthlyInstallment.findMany({
      where: {
        enrollmentId: { in: enrollmentIds },
        status: PaymentStatus.PENDING,
        totalAmountCents: { gt: 0 },
        OR: [{ year: { lt: y } }, { year: y, month: { lt: m } }],
      },
      include: {
        enrollment: { select: { child: { select: { firstName: true, lastName: true } } } },
      },
    });

    for (const row of monthlyRows) {
      // Due date model: month closes, then 2-day grace period.
      const graceStart = new Date(row.year, row.month, 1);
      graceStart.setHours(0, 0, 0, 0);
      const nowMs = now.getTime();
      const graceStartMs = graceStart.getTime();
      if (nowMs < graceStartMs) continue;

      // Reminder cadence: one reminder every 2 days while still pending.
      const slot = Math.floor((nowMs - graceStartMs) / (2 * 24 * 60 * 60 * 1000));
      const ch = `overdue:monthly:${row.id}:r${slot}`;
      const exists = await this.prisma.notification.findFirst({ where: { userId, channel: ch } });
      if (exists) continue;
      const childName = `${row.enrollment.child.firstName} ${row.enrollment.child.lastName}`.trim();
      const mo = String(row.month).padStart(2, '0');
      await this.prisma.notification.create({
        data: {
          userId,
          channel: ch,
          title: 'Paiement en retard — mensualité',
          body: `La mensualité de ${mo}/${row.year} pour ${childName} n’a pas été réglée. Merci d’effectuer le paiement.`,
          kind: 'PAYMENT_OVERDUE',
          enrollmentId: row.enrollmentId,
        },
      });
    }
  }
}
