import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentStatus, UserRole } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as nodemailer from 'nodemailer';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildAdministrativeEmailHtml,
  buildAdministrativeEmailText,
  escapeHtml,
  type AdministrativeMailContent,
  type MailRecapRow,
} from './mail-layout';

function loginUrlFromConfig(config: ConfigService): string {
  return (
    config.get<string>('PARENT_PORTAL_LOGIN_URL')?.trim() || 'http://localhost:3000/parent/login'
  );
}

export type PreEnrollmentMailParams = {
  to: string;
  parentName: string | null;
  /** Affiché sur la ligne « À : » du modèle messagerie. */
  parentPhone?: string | null;
  schoolYear: string;
  /** Une ligne par enfant : ex. "Dupont Marie — Petite Section" */
  childLines: string[];
  /** Mot de passe provisoire si compte créé ou réinitialisé à cette inscription ; sinon le parent utilise déjà un mot de passe existant */
  plainPasswordForEmail: string | null;
};

export type ParentPortalCredentialsParams = {
  to: string;
  parentName: string | null;
  password: string;
};

export type PendingInvoiceLine = {
  reference: string;
  amountLabel: string;
  dueDateLabel: string;
  studentName: string;
};

export type MultipleUnpaidInvoicesMailParams = {
  to: string;
  parentName: string | null;
  parentPhone: string | null;
  /** Nombre total de factures impayées (> 3). */
  totalUnpaid: number;
  /** Détail affiché (ex. 8 premières). */
  invoiceLines: PendingInvoiceLine[];
  /** Si false, n’appelle pas notifyEmailSentToParentEmail (dédoublonnage géré ailleurs). */
  notifyAfterSend?: boolean;
};

function buildMultipleUnpaidRecapTableHtml(lines: PendingInvoiceLine[], total: number): string {
  const rows = lines
    .map(
      (l) => `
    <tr>
      <td style="padding:8px 6px;border-bottom:1px solid #c5e3f4;font-size:13px;color:#0f172a;">${escapeHtml(l.reference)}</td>
      <td style="padding:8px 6px;border-bottom:1px solid #c5e3f4;font-size:13px;font-weight:700;color:#216EC2;">${escapeHtml(l.amountLabel)}</td>
      <td style="padding:8px 6px;border-bottom:1px solid #c5e3f4;font-size:13px;font-weight:700;color:#dc2626;">${escapeHtml(l.dueDateLabel)}</td>
      <td style="padding:8px 6px;border-bottom:1px solid #c5e3f4;font-size:13px;font-weight:700;color:#216EC2;">${escapeHtml(l.studentName)}</td>
    </tr>`,
    )
    .join('');
  const more =
    total > lines.length
      ? `<p style="margin:12px 0 0;font-size:13px;color:#64748b;">… et <strong>${total - lines.length}</strong> autre(s) facture(s) — consultez l’onglet <strong>Paiements</strong> de votre espace parent.</p>`
      : '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
    <thead>
      <tr>
        <th align="left" style="padding:8px 6px;font-size:12px;color:#64748b;border-bottom:1px solid #216EC2;">Référence</th>
        <th align="left" style="padding:8px 6px;font-size:12px;color:#64748b;border-bottom:1px solid #216EC2;">Montant dû</th>
        <th align="left" style="padding:8px 6px;font-size:12px;color:#64748b;border-bottom:1px solid #216EC2;">Date d'échéance</th>
        <th align="left" style="padding:8px 6px;font-size:12px;color:#64748b;border-bottom:1px solid #216EC2;">Élève</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>${more}`;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  /** `undefined` = non résolu ; `null` = fichier absent ; sinon data URI ou URL. */
  private logoSrcCache: string | null | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Tâche planifiée : parcourt les comptes parents et envoie l’e-mail de relance
   * si plus de 3 factures impayées (au plus une fois par jour calendaire et par parent,
   * tant que la situation n’est pas régularisée).
   */
  async runDailyMultipleUnpaidInvoiceReminderBatch(): Promise<void> {
    const dayKey = this.calendarDayKeyLocal(new Date());
    const parents = await this.prisma.user.findMany({
      where: { role: UserRole.PARENT, blocked: false },
      select: { id: true },
    });
    for (const p of parents) {
      try {
        const { total, samples } = await this.loadPendingInvoiceSummaryForParent(p.id);
        if (total > 3) {
          await this.maybeSendMultipleUnpaidInvoiceEmailForParent(p.id, dayKey, total, samples);
        }
      } catch (e) {
        this.logger.warn(
          `Relance factures parent ${p.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  private calendarDayKeyLocal(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private formatXofParent(cents: number): string {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: 'XOF',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  }

  private tuitionDueFrench(schoolYear: string): string {
    const m = schoolYear.trim().match(/^(\d{4})/);
    const y = m ? parseInt(m[1]!, 10) : new Date().getFullYear();
    return new Date(y, 8, 30).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  }

  private monthEndFrench(year: number, month: number): string {
    return new Date(year, month, 0).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  }

  private buildPendingInvoiceLinesFromRows(
    tuitionCharges: Array<{
      status: string;
      amountCents: number;
      schoolYear: string;
      enrollment: { child: { firstName: string; lastName: string } };
    }>,
    monthlyInstallments: Array<{
      status: string;
      totalAmountCents: number;
      year: number;
      month: number;
      enrollment: { child: { firstName: string; lastName: string } };
    }>,
    legacyPayments: Array<{
      status: string;
      amountCents: number;
      year: number;
      month: number;
      enrollment: { child: { firstName: string; lastName: string } };
    }>,
  ): { total: number; samples: PendingInvoiceLine[] } {
    type Acc = PendingInvoiceLine & { sort: number };
    const lines: Acc[] = [];

    for (const t of tuitionCharges) {
      if (t.status !== PaymentStatus.PENDING || !t.amountCents || t.amountCents <= 0) continue;
      const child = `${t.enrollment.child.firstName} ${t.enrollment.child.lastName}`.trim();
      const m = t.schoolYear.match(/^(\d{4})/);
      const y = m ? parseInt(m[1]!, 10) : 0;
      lines.push({
        reference: `Scolarité annuelle — ${t.schoolYear}`,
        amountLabel: this.formatXofParent(t.amountCents),
        dueDateLabel: this.tuitionDueFrench(t.schoolYear),
        studentName: child,
        sort: y * 100 + 9,
      });
    }

    for (const inst of monthlyInstallments) {
      if (inst.status !== PaymentStatus.PENDING || !inst.totalAmountCents || inst.totalAmountCents <= 0) continue;
      const child = `${inst.enrollment.child.firstName} ${inst.enrollment.child.lastName}`.trim();
      const mo = String(inst.month).padStart(2, '0');
      lines.push({
        reference: `Mensualité — ${mo}/${inst.year}`,
        amountLabel: this.formatXofParent(inst.totalAmountCents),
        dueDateLabel: this.monthEndFrench(inst.year, inst.month),
        studentName: child,
        sort: inst.year * 100 + inst.month,
      });
    }

    for (const p of legacyPayments) {
      if (p.status !== PaymentStatus.PENDING || !p.amountCents || p.amountCents <= 0) continue;
      const child = `${p.enrollment.child.firstName} ${p.enrollment.child.lastName}`.trim();
      const mo = String(p.month).padStart(2, '0');
      lines.push({
        reference: `Facture — ${mo}/${p.year}`,
        amountLabel: this.formatXofParent(p.amountCents),
        dueDateLabel: this.monthEndFrench(p.year, p.month),
        studentName: child,
        sort: p.year * 100 + p.month,
      });
    }

    lines.sort((a, b) => a.sort - b.sort);
    const total = lines.length;
    const samples = lines.slice(0, 6).map(({ reference, amountLabel, dueDateLabel, studentName }) => ({
      reference,
      amountLabel,
      dueDateLabel,
      studentName,
    }));
    return { total, samples };
  }

  /** Sans resynchronisation billing (utilisé par le batch planifié). */
  private async loadPendingInvoiceSummaryForParent(
    parentUserId: string,
  ): Promise<{ total: number; samples: PendingInvoiceLine[] }> {
    const children = await this.prisma.child.findMany({
      where: { parentId: parentUserId },
      select: { enrollments: { select: { id: true } } },
    });
    const enrollmentIds = [...new Set(children.flatMap((c) => c.enrollments.map((e) => e.id)))];
    if (enrollmentIds.length === 0) return { total: 0, samples: [] };

    const [legacyPayments, tuitionCharges, monthlyInstallments] = await Promise.all([
      this.prisma.monthlyPayment.findMany({
        where: { enrollmentId: { in: enrollmentIds } },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        include: {
          enrollment: {
            select: {
              child: { select: { firstName: true, lastName: true } },
            },
          },
        },
      }),
      this.prisma.tuitionCharge.findMany({
        where: { enrollmentId: { in: enrollmentIds } },
        orderBy: { schoolYear: 'desc' },
        include: {
          enrollment: {
            select: {
              child: { select: { firstName: true, lastName: true } },
            },
          },
        },
      }),
      this.prisma.monthlyInstallment.findMany({
        where: { enrollmentId: { in: enrollmentIds } },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        include: {
          enrollment: {
            select: {
              child: { select: { firstName: true, lastName: true } },
            },
          },
        },
      }),
    ]);

    return this.buildPendingInvoiceLinesFromRows(tuitionCharges, monthlyInstallments, legacyPayments);
  }

  private async maybeSendMultipleUnpaidInvoiceEmailForParent(
    parentUserId: string,
    dayKey: string,
    totalPending: number,
    samples: PendingInvoiceLine[],
  ): Promise<void> {
    const channel = `multi-unpaid-email:${dayKey}`;
    const already = await this.prisma.notification.findFirst({
      where: { userId: parentUserId, channel },
    });
    if (already) return;

    const user = await this.prisma.user.findFirst({
      where: { id: parentUserId, role: UserRole.PARENT, blocked: false },
      select: { email: true, fullName: true, phone: true },
    });
    const email = user?.email?.trim().toLowerCase();
    if (!email || !user) return;

    const sent = await this.sendParentMultipleUnpaidInvoicesReminder({
      to: email,
      parentName: user.fullName,
      parentPhone: user.phone,
      totalUnpaid: totalPending,
      invoiceLines: samples,
      notifyAfterSend: false,
    });
    if (!sent) return;

    await this.prisma.notification.create({
      data: {
        userId: parentUserId,
        channel,
        title: 'Relance — factures impayées',
        body: `Un e-mail administratif vous a été envoyé concernant ${totalPending} factures impayées.`,
        kind: 'EMAIL',
      },
    });
  }

  private createTransport(): nodemailer.Transporter | null {
    const host =
      this.config.get<string>('SMTP_HOST')?.trim() || this.config.get<string>('MAIL_HOST')?.trim();
    if (!host) return null;

    const port = Number(
      this.config.get<string>('SMTP_PORT') ?? this.config.get<string>('MAIL_PORT') ?? '587',
    );
    const secureFlag =
      this.config.get<string>('SMTP_SECURE') ?? this.config.get<string>('MAIL_SECURE') ?? 'false';
    const secure = secureFlag === 'true' || secureFlag === '1';
    const user =
      this.config.get<string>('SMTP_USER')?.trim() || this.config.get<string>('MAIL_USER')?.trim();
    const pass = this.config.get<string>('SMTP_PASS') ?? this.config.get<string>('MAIL_PASS');

    return nodemailer.createTransport({
      host,
      port,
      secure,
      auth:
        user && pass !== undefined && pass !== ''
          ? { user, pass: String(pass) }
          : undefined,
    });
  }

  private adminDisplayEmail(): string {
    return (
      this.config.get<string>('MAIL_ADMIN_DISPLAY_EMAIL')?.trim() ||
      'administration@commonwealth-school.com'
    );
  }

  /**
   * Préfère MAIL_LOGO_URL si défini ; sinon logo du dépôt (même fichier que le front
   * `assets/images/logo.png`), copié sous `src/mail/assets/logo.png` et embarqué en data URI.
   */
  private logoUrl(): string | null {
    const configured = this.config.get<string>('MAIL_LOGO_URL')?.trim();
    if (configured) return configured;
    if (this.logoSrcCache === null) return null;
    if (this.logoSrcCache !== undefined) return this.logoSrcCache;
    try {
      const buf = readFileSync(join(__dirname, 'assets', 'logo.png'));
      this.logoSrcCache = `data:image/png;base64,${buf.toString('base64')}`;
      return this.logoSrcCache;
    } catch {
      this.logoSrcCache = null;
      return null;
    }
  }

  private adminPhone(): string {
    return this.config.get<string>('MAIL_ADMIN_PHONE')?.trim() || '(307) 555-0133';
  }

  private emergencyPhone(): string {
    return this.config.get<string>('MAIL_EMERGENCY_PHONE')?.trim() || '(219) 555-0114';
  }

  /** Confirmation de pré-inscription (statut en attente côté administration). */
  async sendPreEnrollmentConfirmation(params: PreEnrollmentMailParams): Promise<void> {
    const from =
      this.config.get<string>('MAIL_FROM')?.trim() || 'Commonwealth School <noreply@commonwealth.local>';

    const transport = this.createTransport();
    const subjectBold = `Confirmation de pré-inscription — Année ${params.schoolYear}`;
    const subject = `Commonwealth School — ${subjectBold}`;

    const displayName = params.parentName?.trim() || 'Parent';
    const greeting = params.parentName?.trim()
      ? `Bonjour ${escapeHtml(params.parentName.trim())},`
      : 'Bonjour,';

    const childrenHtml = params.childLines.map((l) => escapeHtml(l)).join('<br />');
    const childrenText = params.childLines.map((l) => `- ${l}`).join('\n');

    const loginUrl = loginUrlFromConfig(this.config);

    const credentialsHtml = params.plainPasswordForEmail
      ? `<p>Vous pouvez dès maintenant accéder à votre <strong>espace parent</strong>&nbsp;:</p>
        <ul style="margin:8px 0;padding-left:20px;">
          <li><strong>E-mail (identifiant)</strong>&nbsp;: ${escapeHtml(params.to)}</li>
          <li><strong>Mot de passe provisoire</strong>&nbsp;: <code style="background:#f1f5f9;padding:2px 6px;border-radius:4px;">${escapeHtml(params.plainPasswordForEmail)}</code></li>
        </ul>
        <p><a href="${escapeHtml(loginUrl)}" style="color:#216EC2;font-weight:600;">Se connecter à l’espace parent</a></p>
        <p>Nous vous recommandons de <strong>modifier ce mot de passe</strong> après votre première connexion.</p>`
      : `<p>Vous avez déjà un compte espace parent&nbsp;: connectez-vous avec le même e-mail et le mot de passe déjà communiqué.</p>
        <p><a href="${escapeHtml(loginUrl)}" style="color:#216EC2;font-weight:600;">Se connecter à l’espace parent</a></p>`;

    const introHtml = `
      <p style="margin:0 0 12px;">${greeting}</p>
      <p style="margin:0 0 12px;">Nous avons bien enregistré votre <strong>demande de pré-inscription</strong> pour l’année scolaire <strong>${escapeHtml(params.schoolYear)}</strong>.</p>
      <p style="margin:0;">Votre dossier est <strong>en attente de validation</strong> par l’administration. Vous recevrez un message dès que votre inscription aura été examinée.</p>`;

    const recapRows: MailRecapRow[] = [
      { label: 'Année scolaire', value: escapeHtml(params.schoolYear) },
      {
        label: 'Enfant(s) concerné(s)',
        value: childrenHtml || '—',
      },
      { label: 'Statut du dossier', value: 'En attente de validation', valueTone: 'blue' },
    ];

    const footerBodyHtml = `${credentialsHtml}
      <p style="margin:16px 0 0;">Pour toute question, vous pouvez répondre à ce message ou contacter le service administratif aux coordonnées ci-dessous.</p>`;

    const signatureBlockHtml = `
      <strong style="font-size:15px;">Service administratif</strong><br />
      Commonwealth School<br />
      <a href="mailto:${escapeHtml(this.adminDisplayEmail())}" style="color:#ffffff;text-decoration:underline;">${escapeHtml(this.adminDisplayEmail())}</a><br />
      ${escapeHtml(this.adminPhone())}`;

    const layout: AdministrativeMailContent = {
      fromDisplay: this.adminDisplayEmail(),
      toEmail: params.to,
      toDisplayName: displayName,
      toPhone: params.parentPhone?.trim() || null,
      subjectBold,
      introHtml,
      recapRows,
      footerBodyHtml,
      signatureBlockHtml,
      logoUrl: this.logoUrl(),
      adminPhone: this.adminPhone(),
      emergencyPhone: this.emergencyPhone(),
    };

    const html = buildAdministrativeEmailHtml(layout);

    const text = buildAdministrativeEmailText({
      subjectBold,
      fromDisplay: this.adminDisplayEmail(),
      toLine: [params.to, displayName, params.parentPhone?.trim()].filter(Boolean).join(' · '),
      introText: [
        params.parentName?.trim() ? `Bonjour ${params.parentName.trim()},` : 'Bonjour,',
        '',
        `Nous avons bien enregistré votre demande de pré-inscription pour l'année scolaire ${params.schoolYear}.`,
        'Enfants concernés :',
        childrenText,
        '',
        'Votre dossier est en attente de validation par l’administration.',
      ].join('\n'),
      recapLines: [
        `Année scolaire: ${params.schoolYear}`,
        `Enfants: ${childrenText}`,
        'Statut: En attente de validation',
      ],
      footerText: params.plainPasswordForEmail
        ? [
            'Espace parent :',
            `E-mail : ${params.to}`,
            `Mot de passe provisoire : ${params.plainPasswordForEmail}`,
            `Connexion : ${loginUrl}`,
          ].join('\n')
        : `Connexion espace parent : ${loginUrl}`,
      signatureText: [
        'Service administratif',
        'Commonwealth School',
        this.adminDisplayEmail(),
        this.adminPhone(),
      ].join('\n'),
      emergencyPhone: this.emergencyPhone(),
    });

    if (!transport) {
      this.logger.warn(`E-mail non envoyé (SMTP non configuré). Destinataire : ${params.to}`);
      return;
    }

    try {
      await transport.sendMail({
        from,
        to: params.to,
        subject,
        text,
        html,
      });
      this.logger.log(`E-mail de pré-inscription envoyé à ${params.to}`);
      await this.notifications.notifyEmailSentToParentEmail(params.to, subject).catch(() => undefined);
    } catch (err) {
      this.logger.error(`Échec envoi e-mail à ${params.to}`, err instanceof Error ? err.stack : err);
    }
  }

  /** Relance lorsque le parent a plus de trois factures impayées (design identique à la messagerie administrative). */
  async sendParentMultipleUnpaidInvoicesReminder(params: MultipleUnpaidInvoicesMailParams): Promise<boolean> {
    const from =
      this.config.get<string>('MAIL_FROM')?.trim() || 'Commonwealth School <noreply@commonwealth.local>';

    const transport = this.createTransport();
    const subjectBold = `Rappel de paiement — ${params.totalUnpaid} factures impayées`;
    const subject = `Commonwealth School — ${subjectBold}`;

    const displayName = params.parentName?.trim() || 'Parent';
    const greeting = params.parentName?.trim()
      ? `Bonjour ${escapeHtml(params.parentName.trim())},`
      : 'Bonjour,';

    const portalUrl = loginUrlFromConfig(this.config);

    const introHtml = `
      <p style="margin:0 0 12px;">${greeting}</p>
      <p style="margin:0 0 12px;">Nous revenons vers vous concernant le <strong>règlement de la scolarité</strong>. À ce jour, <strong>${params.totalUnpaid} factures</strong> figurent comme <strong>non payées</strong> sur votre compte famille.</p>
      <p style="margin:0;">Merci de <strong>régulariser votre situation</strong> dans les meilleurs délais afin d’éviter toute difficulté pour votre ou vos enfant(s).</p>`;

    const recapHtmlOverride = buildMultipleUnpaidRecapTableHtml(
      params.invoiceLines,
      params.totalUnpaid,
    );

    const footerBodyHtml = `
      <p style="margin:0 0 12px;">Vous pouvez régler vos factures depuis votre <strong>espace parent</strong> (rubrique Paiements) ou par les moyens habituels communiqués par l’établissement (virement bancaire, Wave, Orange Money, etc.).</p>
      <p style="margin:0;"><a href="${escapeHtml(portalUrl)}" style="color:#216EC2;font-weight:600;">Accéder à l’espace parent — Paiements</a></p>`;

    const signatureBlockHtml = `
      <strong style="font-size:15px;">Service administratif</strong><br />
      Commonwealth School<br />
      <a href="mailto:${escapeHtml(this.adminDisplayEmail())}" style="color:#ffffff;text-decoration:underline;">${escapeHtml(this.adminDisplayEmail())}</a><br />
      ${escapeHtml(this.adminPhone())}`;

    const layout: AdministrativeMailContent = {
      fromDisplay: this.adminDisplayEmail(),
      toEmail: params.to,
      toDisplayName: displayName,
      toPhone: params.parentPhone?.trim() || null,
      subjectBold,
      introHtml,
      recapRows: [],
      recapHtmlOverride,
      footerBodyHtml,
      signatureBlockHtml,
      logoUrl: this.logoUrl(),
      adminPhone: this.adminPhone(),
      emergencyPhone: this.emergencyPhone(),
    };

    const html = buildAdministrativeEmailHtml(layout);

    const recapText = params.invoiceLines
      .flatMap((l) => [
        `Référence: ${l.reference}`,
        `Montant dû: ${l.amountLabel}`,
        `Date d'échéance: ${l.dueDateLabel}`,
        `Élève: ${l.studentName}`,
        '',
      ])
      .join('\n');

    const text = buildAdministrativeEmailText({
      subjectBold,
      fromDisplay: this.adminDisplayEmail(),
      toLine: [params.to, displayName, params.parentPhone?.trim()].filter(Boolean).join(' · '),
      introText: [
        params.parentName?.trim() ? `Bonjour ${params.parentName.trim()},` : 'Bonjour,',
        '',
        `${params.totalUnpaid} factures sont actuellement non payées sur votre compte.`,
        'Merci de régulariser votre situation.',
      ].join('\n'),
      recapLines: recapText.split('\n'),
      footerText: `Espace parent (paiements) : ${portalUrl}`,
      signatureText: [
        'Service administratif',
        'Commonwealth School',
        this.adminDisplayEmail(),
        this.adminPhone(),
      ].join('\n'),
      emergencyPhone: this.emergencyPhone(),
    });

    if (!transport) {
      this.logger.warn(`E-mail relance factures non envoyé (SMTP non configuré). Destinataire : ${params.to}`);
      return false;
    }

    try {
      await transport.sendMail({
        from,
        to: params.to,
        subject,
        text,
        html,
      });
      this.logger.log(`E-mail relance factures impayées (>3) envoyé à ${params.to}`);
      if (params.notifyAfterSend !== false) {
        await this.notifications.notifyEmailSentToParentEmail(params.to, subject).catch(() => undefined);
      }
      return true;
    } catch (err) {
      this.logger.error(`Échec envoi relance factures à ${params.to}`, err instanceof Error ? err.stack : err);
      return false;
    }
  }

  /** Envoyé après validation admin : mot de passe provisoire pour l’espace parent. */
  async sendParentPortalCredentials(params: ParentPortalCredentialsParams): Promise<void> {
    const from =
      this.config.get<string>('MAIL_FROM')?.trim() || 'Commonwealth School <noreply@commonwealth.local>';

    const loginUrl = loginUrlFromConfig(this.config);

    const transport = this.createTransport();
    const subject = 'Commonwealth School — Votre espace parent';

    const greeting = params.parentName?.trim() ? `Bonjour ${params.parentName.trim()},` : 'Bonjour,';

    const text = [
      greeting,
      '',
      'Votre demande d’inscription a été validée. Voici vos identifiants pour accéder à l’espace parent :',
      '',
      `E-mail (identifiant) : ${params.to}`,
      `Mot de passe provisoire : ${params.password}`,
      '',
      `Connexion : ${loginUrl}`,
      '',
      'Pour des raisons de sécurité, nous vous recommandons de changer ce mot de passe après votre première connexion.',
      '',
      'Cordialement,',
      'Commonwealth School',
    ].join('\n');

    const html = `
<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #334155;">
  <p>${escapeHtml(greeting)}</p>
  <p>Votre demande d’inscription a été <strong>validée</strong>. Voici vos identifiants pour accéder à l’<strong>espace parent</strong>&nbsp;:</p>
  <ul>
    <li><strong>E-mail (identifiant)</strong>&nbsp;: ${escapeHtml(params.to)}</li>
    <li><strong>Mot de passe provisoire</strong>&nbsp;: <code>${escapeHtml(params.password)}</code></li>
  </ul>
  <p><a href="${escapeHtml(loginUrl)}">Se connecter</a></p>
  <p>Pour des raisons de sécurité, changez ce mot de passe après votre première connexion.</p>
  <p>Cordialement,<br/>Commonwealth School</p>
</body>
</html>`;

    if (!transport) {
      this.logger.warn(
        `E-mail identifiants parent non envoyé (SMTP non configuré). Destinataire : ${params.to}`,
      );
      return;
    }

    try {
      await transport.sendMail({ from, to: params.to, subject, text, html });
      this.logger.log(`E-mail identifiants parent envoyé à ${params.to}`);
      await this.notifications.notifyEmailSentToParentEmail(params.to, subject).catch(() => undefined);
    } catch (err) {
      this.logger.error(`Échec envoi identifiants à ${params.to}`, err instanceof Error ? err.stack : err);
    }
  }
}
