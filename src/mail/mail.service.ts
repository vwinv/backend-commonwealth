import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentStatus, UserRole } from '@prisma/client';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as nodemailer from 'nodemailer';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { readSchoolContact } from '../config/school-contact';
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

function parentCredentialsRecapRows(
  to: string,
  plainPasswordForEmail: string | null,
): MailRecapRow[] {
  const rows: MailRecapRow[] = [
    {
      label: 'Identifiant espace parent',
      value: escapeHtml(to),
      valueTone: 'blue',
    },
  ];
  if (plainPasswordForEmail) {
    rows.push({
      label: 'Mot de passe provisoire',
      value: `<code style="background:#f1f5f9;padding:2px 8px;border-radius:4px;font-size:14px;">${escapeHtml(plainPasswordForEmail)}</code>`,
      valueTone: 'blue',
    });
  }
  return rows;
}

function parentCredentialsIntroHtml(
  to: string,
  plainPasswordForEmail: string | null,
  loginUrl: string,
): string {
  if (plainPasswordForEmail) {
    return `<div style="margin:0 0 18px;padding:16px 18px;border-radius:10px;border:2px solid #216EC2;background:#e9f5fc;">
        <p style="margin:0 0 10px;font-size:15px;font-weight:700;color:#0f172a;">Vos identifiants espace parent</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;color:#1e293b;">
          <tr>
            <td style="padding:4px 12px 4px 0;vertical-align:top;color:#64748b;width:42%;">E-mail (identifiant)</td>
            <td style="padding:4px 0;vertical-align:top;font-weight:700;color:#216EC2;">${escapeHtml(to)}</td>
          </tr>
          <tr>
            <td style="padding:4px 12px 4px 0;vertical-align:top;color:#64748b;">Mot de passe provisoire</td>
            <td style="padding:4px 0;vertical-align:top;">
              <code style="background:#ffffff;padding:4px 10px;border-radius:6px;font-size:15px;font-weight:700;color:#0f172a;border:1px solid #cbd5e1;">${escapeHtml(plainPasswordForEmail)}</code>
            </td>
          </tr>
        </table>
        <p style="margin:12px 0 0;">
          <a href="${escapeHtml(loginUrl)}" style="color:#216EC2;font-weight:700;text-decoration:none;">→ Se connecter à l'espace parent</a>
        </p>
        <p style="margin:8px 0 0;font-size:13px;color:#475569;">Modifiez ce mot de passe après votre première connexion.</p>
      </div>`;
  }
  return `<div style="margin:0 0 18px;padding:16px 18px;border-radius:10px;border:1px solid #cbd5e1;background:#f8fafc;">
      <p style="margin:0 0 8px;font-size:15px;font-weight:700;color:#0f172a;">Espace parent</p>
      <p style="margin:0 0 6px;font-size:14px;color:#1e293b;">
        <strong>Identifiant :</strong> ${escapeHtml(to)}
      </p>
      <p style="margin:0 0 8px;font-size:14px;color:#475569;">
        Connectez-vous avec le mot de passe déjà communiqué, ou utilisez « Mot de passe oublié » sur la page de connexion.
      </p>
      <p style="margin:0;">
        <a href="${escapeHtml(loginUrl)}" style="color:#216EC2;font-weight:700;text-decoration:none;">→ Se connecter à l'espace parent</a>
      </p>
    </div>`;
}

function parentCredentialsFooterHtml(
  to: string,
  plainPasswordForEmail: string | null,
  loginUrl: string,
): string {
  if (plainPasswordForEmail) {
    return `<p style="margin:0;">Conservez ces identifiants pour accéder à votre espace parent.</p>`;
  }
  return `<p style="margin:0;">Identifiant espace parent : <strong>${escapeHtml(to)}</strong></p>`;
}

function inscriptionResumeUrlFromConfig(config: ConfigService, resumeToken: string): string {
  const explicit = config.get<string>('PUBLIC_INSCRIPTION_URL')?.trim();
  if (explicit) {
    const base = explicit.replace(/\/$/, '');
    return `${base}?resume=${encodeURIComponent(resumeToken)}`;
  }
  const login = loginUrlFromConfig(config);
  const site = login.replace(/\/parent\/login\/?$/i, '') || 'http://localhost:3000';
  return `${site.replace(/\/$/, '')}/inscription?resume=${encodeURIComponent(resumeToken)}`;
}

function adminLoginUrlFromConfig(config: ConfigService): string {
  return (
    config.get<string>('ADMIN_PORTAL_LOGIN_URL')?.trim() || 'http://localhost:3000/admin/login'
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

export type EnrollmentProgressMailParams = {
  to: string;
  parentName: string | null;
  parentPhone?: string | null;
  schoolYear: string;
  childLine: string;
  resumeUrl: string;
  plainPasswordForEmail: string | null;
};

export type EnrollmentApprovedMailParams = {
  to: string;
  parentName: string | null;
  parentPhone?: string | null;
  schoolYear: string;
  childLine: string;
};

export type HealthSignatureRequestMailParams = {
  to: string;
  parentName: string | null;
  parentPhone?: string | null;
  childName: string;
};

export type ParentPortalCredentialsParams = {
  to: string;
  parentName: string | null;
  password: string;
};

export type StaffPortalCredentialsParams = {
  to: string;
  fullName: string | null;
  password: string;
  jobTitle?: string | null;
  /** Réinitialisation par un administrateur (texte d’e-mail adapté). */
  isPasswordReset?: boolean;
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
  private static readonly LOGO_CID = 'commonwealth-logo@mail';
  private resolvedLogoPathCache: string | null | undefined;

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

  private schoolDisplayName(): string {
    return readSchoolContact(this.config).displayName;
  }

  private mailFromDefault(): string {
    return `${this.schoolDisplayName()} <noreply@commonwealth.local>`;
  }

  private adminDisplayEmail(): string {
    return readSchoolContact(this.config).directionEmail;
  }

  /**
   * Logo pour les e-mails administratifs.
   * Préfère MAIL_LOGO_URL (URL publique) ; sinon fichier embarqué en pièce jointe CID
   * (compatible Gmail/Outlook — les data URI sont souvent bloquées).
   */
  private getMailLogo(): {
    logoUrl: string | null;
    attachments: { filename: string; path: string; cid: string }[];
  } {
    const configured = this.config.get<string>('MAIL_LOGO_URL')?.trim();
    if (configured) {
      return { logoUrl: configured, attachments: [] };
    }

    const path = this.resolveLogoPath();
    if (!path) {
      this.logger.warn(
        'Logo e-mail introuvable (définir MAIL_LOGO_URL ou placer logo.png dans src/mail/assets/).',
      );
      return { logoUrl: null, attachments: [] };
    }

    return {
      logoUrl: `cid:${MailService.LOGO_CID}`,
      attachments: [{ filename: 'logo.png', path, cid: MailService.LOGO_CID }],
    };
  }

  /** Nest copie `src/mail/assets` vers `dist/mail/assets` ; le JS compilé est sous `dist/src/mail/`. */
  private resolveLogoPath(): string | undefined {
    if (this.resolvedLogoPathCache === null) return undefined;
    if (this.resolvedLogoPathCache !== undefined) return this.resolvedLogoPathCache;

    const cwd = process.cwd();
    const candidates = [
      join(__dirname, 'assets', 'logo.png'),
      join(__dirname, '..', 'mail', 'assets', 'logo.png'),
      join(__dirname, '..', '..', 'mail', 'assets', 'logo.png'),
      join(cwd, 'dist', 'mail', 'assets', 'logo.png'),
      join(cwd, 'src', 'mail', 'assets', 'logo.png'),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        this.resolvedLogoPathCache = p;
        return p;
      }
    }
    this.resolvedLogoPathCache = null;
    return undefined;
  }

  private adminPhone(): string {
    return readSchoolContact(this.config).adminPhone;
  }

  private emergencyPhone(): string {
    return readSchoolContact(this.config).emergencyPhone;
  }

  /** Confirmation de pré-inscription (statut en attente côté administration). */
  async sendPreEnrollmentConfirmation(params: PreEnrollmentMailParams): Promise<void> {
    const from =
      this.config.get<string>('MAIL_FROM')?.trim() || this.mailFromDefault();

    const transport = this.createTransport();
    const mailLogo = this.getMailLogo();
    const subjectBold = `Confirmation de pré-inscription — Année ${params.schoolYear}`;
    const subject = `${this.schoolDisplayName()} — ${subjectBold}`;

    const displayName = params.parentName?.trim() || 'Parent';
    const greeting = params.parentName?.trim()
      ? `Bonjour ${escapeHtml(params.parentName.trim())},`
      : 'Bonjour,';

    const childrenHtml = params.childLines.map((l) => escapeHtml(l)).join('<br />');
    const childrenText = params.childLines.map((l) => `- ${l}`).join('\n');

    const loginUrl = loginUrlFromConfig(this.config);

    const credentialsIntroHtml = parentCredentialsIntroHtml(
      params.to,
      params.plainPasswordForEmail,
      loginUrl,
    );
    const credentialsHtml = parentCredentialsFooterHtml(params.to, params.plainPasswordForEmail, loginUrl);

    const introHtml = `
      ${credentialsIntroHtml}
      <p style="margin:0 0 12px;">${greeting}</p>
      <p style="margin:0 0 12px;">Nous avons bien enregistré votre <strong>demande de pré-inscription</strong> pour l'année scolaire <strong>${escapeHtml(params.schoolYear)}</strong>.</p>
      <p style="margin:0;">Votre dossier est <strong>en attente de validation</strong> par l'administration. Vous recevrez un message dès que votre inscription aura été examinée.</p>`;

    const recapRows: MailRecapRow[] = [
      { label: 'Année scolaire', value: escapeHtml(params.schoolYear) },
      {
        label: 'Enfant(s) concerné(s)',
        value: childrenHtml || '—',
      },
      { label: 'Statut du dossier', value: 'En attente de validation', valueTone: 'blue' },
      ...parentCredentialsRecapRows(params.to, params.plainPasswordForEmail),
    ];

    const footerBodyHtml = `${credentialsHtml}
      <p style="margin:16px 0 0;">Pour toute question, vous pouvez répondre à ce message ou contacter le service administratif aux coordonnées ci-dessous.</p>`;

    const signatureBlockHtml = `
      <strong style="font-size:15px;">Service administratif</strong><br />
      ${escapeHtml(this.schoolDisplayName())}<br />
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
      logoUrl: mailLogo.logoUrl,
      adminPhone: this.adminPhone(),
      emergencyPhone: this.emergencyPhone(),
      schoolDisplayName: this.schoolDisplayName(),
    };

    const html = buildAdministrativeEmailHtml(layout);

    const text = buildAdministrativeEmailText({
      subjectBold,
      fromDisplay: this.adminDisplayEmail(),
      toLine: [params.to, displayName, params.parentPhone?.trim()].filter(Boolean).join(' · '),
      introText: [
        params.parentName?.trim() ? `Bonjour ${params.parentName.trim()},` : 'Bonjour,',
        '',
        ...(params.plainPasswordForEmail
          ? [
              'Vos identifiants espace parent :',
              `E-mail : ${params.to}`,
              `Mot de passe provisoire : ${params.plainPasswordForEmail}`,
              `Connexion : ${loginUrl}`,
              '',
            ]
          : [`Identifiant espace parent : ${params.to}`, `Connexion : ${loginUrl}`, '']),
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
        `Identifiant espace parent: ${params.to}`,
        ...(params.plainPasswordForEmail
          ? [`Mot de passe provisoire: ${params.plainPasswordForEmail}`]
          : []),
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
        this.schoolDisplayName(),
        this.adminDisplayEmail(),
        this.adminPhone(),
      ].join('\n'),
      emergencyPhone: this.emergencyPhone(),
      schoolDisplayName: this.schoolDisplayName(),
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
        attachments: mailLogo.attachments.length ? mailLogo.attachments : undefined,
      });
      this.logger.log(`E-mail de pré-inscription envoyé à ${params.to}`);
      await this.notifications.notifyEmailSentToParentEmail(params.to, subject).catch(() => undefined);
    } catch (err) {
      this.logger.error(`Échec envoi e-mail à ${params.to}`, err instanceof Error ? err.stack : err);
    }
  }

  /** Dossier d'inscription enregistré en cours de route (étape famille) — reprise possible plus tard. */
  async sendEnrollmentProgressSaved(params: EnrollmentProgressMailParams): Promise<void> {
    const from =
      this.config.get<string>('MAIL_FROM')?.trim() || this.mailFromDefault();

    const transport = this.createTransport();
    const mailLogo = this.getMailLogo();
    const subjectBold = `Dossier d'inscription enregistré — Année ${params.schoolYear}`;
    const subject = `${this.schoolDisplayName()} — ${subjectBold}`;

    const displayName = params.parentName?.trim() || 'Parent';
    const greeting = params.parentName?.trim()
      ? `Bonjour ${escapeHtml(params.parentName.trim())},`
      : 'Bonjour,';

    const loginUrl = loginUrlFromConfig(this.config);

    const credentialsIntroHtml = parentCredentialsIntroHtml(
      params.to,
      params.plainPasswordForEmail,
      loginUrl,
    );
    const credentialsHtml = parentCredentialsFooterHtml(params.to, params.plainPasswordForEmail, loginUrl);

    const introHtml = `
      ${credentialsIntroHtml}
      <p style="margin:0 0 12px;">${greeting}</p>
      <p style="margin:0 0 12px;">Nous avons bien <strong>enregistré votre dossier d'inscription</strong> pour l'année scolaire <strong>${escapeHtml(params.schoolYear)}</strong>.</p>
      <p style="margin:0;">Vous pouvez <strong>terminer l'inscription quand vous le souhaitez</strong> (fiche médicale, options, validation) via le lien ci-dessous.</p>`;

    const recapRows: MailRecapRow[] = [
      { label: 'Année scolaire', value: escapeHtml(params.schoolYear) },
      { label: 'Enfant', value: escapeHtml(params.childLine) },
      { label: 'État du dossier', value: 'À compléter', valueTone: 'blue' },
      ...parentCredentialsRecapRows(params.to, params.plainPasswordForEmail),
    ];

    const footerBodyHtml = `${credentialsHtml}
      <p style="margin:16px 0 12px;"><a href="${escapeHtml(params.resumeUrl)}" style="display:inline-block;padding:12px 24px;background:#216EC2;color:#ffffff;font-weight:700;text-decoration:none;border-radius:8px;">Reprendre mon inscription</a></p>
      <p style="margin:0;">Conservez ce lien pour reprendre sur un autre appareil. Pour toute question, contactez le service administratif.</p>`;

    const signatureBlockHtml = `
      <strong style="font-size:15px;">Service administratif</strong><br />
      ${escapeHtml(this.schoolDisplayName())}<br />
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
      logoUrl: mailLogo.logoUrl,
      adminPhone: this.adminPhone(),
      emergencyPhone: this.emergencyPhone(),
      schoolDisplayName: this.schoolDisplayName(),
    };

    const html = buildAdministrativeEmailHtml(layout);

    const text = buildAdministrativeEmailText({
      subjectBold,
      fromDisplay: this.adminDisplayEmail(),
      toLine: [params.to, displayName, params.parentPhone?.trim()].filter(Boolean).join(' · '),
      introText: [
        params.parentName?.trim() ? `Bonjour ${params.parentName.trim()},` : 'Bonjour,',
        '',
        ...(params.plainPasswordForEmail
          ? [
              'VOS IDENTIFIANTS ESPACE PARENT',
              `E-mail (identifiant) : ${params.to}`,
              `Mot de passe provisoire : ${params.plainPasswordForEmail}`,
              `Connexion : ${loginUrl}`,
              '',
            ]
          : [`Identifiant espace parent : ${params.to}`, `Connexion : ${loginUrl}`, '']),
        `Nous avons bien enregistré votre dossier d'inscription pour l'année scolaire ${params.schoolYear}.`,
        `Enfant : ${params.childLine}`,
        '',
        "Vous pouvez terminer l'inscription quand vous le souhaitez via le lien ci-dessous.",
      ].join('\n'),
      recapLines: [
        `Année scolaire: ${params.schoolYear}`,
        `Enfant: ${params.childLine}`,
        'État: À compléter',
        `Identifiant espace parent: ${params.to}`,
        ...(params.plainPasswordForEmail
          ? [`Mot de passe provisoire: ${params.plainPasswordForEmail}`]
          : []),
      ],
      footerText: [
        params.plainPasswordForEmail
          ? `Espace parent — E-mail : ${params.to} — Mot de passe provisoire : ${params.plainPasswordForEmail}`
          : `Espace parent : ${loginUrl}`,
        `Reprendre l'inscription : ${params.resumeUrl}`,
      ].join('\n'),
      signatureText: [
        'Service administratif',
        this.schoolDisplayName(),
        this.adminDisplayEmail(),
        this.adminPhone(),
      ].join('\n'),
      emergencyPhone: this.emergencyPhone(),
      schoolDisplayName: this.schoolDisplayName(),
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
        attachments: mailLogo.attachments.length ? mailLogo.attachments : undefined,
      });
      this.logger.log(`E-mail de reprise d'inscription envoyé à ${params.to}`);
      await this.notifications.notifyEmailSentToParentEmail(params.to, subject).catch(() => undefined);
    } catch (err) {
      this.logger.error(`Échec envoi e-mail à ${params.to}`, err instanceof Error ? err.stack : err);
    }
  }

  /** Confirmation d’approbation d’inscription (même format administratif que la pré-inscription). */
  async sendEnrollmentApprovedConfirmation(params: EnrollmentApprovedMailParams): Promise<void> {
    const from =
      this.config.get<string>('MAIL_FROM')?.trim() || this.mailFromDefault();

    const transport = this.createTransport();
    const mailLogo = this.getMailLogo();
    const subjectBold = `Inscription approuvée — Année ${params.schoolYear}`;
    const subject = `${this.schoolDisplayName()} — ${subjectBold}`;

    const displayName = params.parentName?.trim() || 'Parent';
    const greeting = params.parentName?.trim()
      ? `Bonjour ${escapeHtml(params.parentName.trim())},`
      : 'Bonjour,';

    const introHtml = `
      <p style="margin:0 0 12px;">${greeting}</p>
      <p style="margin:0 0 12px;">Nous vous confirmons que votre demande d’inscription pour l’année scolaire <strong>${escapeHtml(params.schoolYear)}</strong> a été <strong>approuvée</strong> par l’administration.</p>
      <p style="margin:0;">Vous pouvez consulter votre espace parent pour le suivi et les paiements associés.</p>`;

    const recapRows: MailRecapRow[] = [
      { label: 'Année scolaire', value: escapeHtml(params.schoolYear) },
      { label: 'Élève concerné', value: escapeHtml(params.childLine) || '—' },
      { label: 'Statut du dossier', value: 'Inscription approuvée', valueTone: 'blue' },
    ];

    const loginUrl = loginUrlFromConfig(this.config);
    const footerBodyHtml = `
      <p style="margin:0 0 12px;">Accédez à votre espace parent pour suivre le dossier et procéder au règlement des frais de scolarité.</p>
      <p style="margin:0;"><a href="${escapeHtml(loginUrl)}" style="color:#216EC2;font-weight:600;">Se connecter à l’espace parent</a></p>`;

    const signatureBlockHtml = `
      <strong style="font-size:15px;">Service administratif</strong><br />
      ${escapeHtml(this.schoolDisplayName())}<br />
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
      logoUrl: mailLogo.logoUrl,
      adminPhone: this.adminPhone(),
      emergencyPhone: this.emergencyPhone(),
      schoolDisplayName: this.schoolDisplayName(),
    };

    const html = buildAdministrativeEmailHtml(layout);

    const text = buildAdministrativeEmailText({
      subjectBold,
      fromDisplay: this.adminDisplayEmail(),
      toLine: [params.to, displayName, params.parentPhone?.trim()].filter(Boolean).join(' · '),
      introText: [
        params.parentName?.trim() ? `Bonjour ${params.parentName.trim()},` : 'Bonjour,',
        '',
        `Votre demande d'inscription pour l'année scolaire ${params.schoolYear} a été approuvée.`,
        '',
        `Élève concerné : ${params.childLine}`,
        '',
        `Connexion espace parent : ${loginUrl}`,
      ].join('\n'),
      recapLines: [
        `Année scolaire: ${params.schoolYear}`,
        `Élève concerné: ${params.childLine}`,
        'Statut: Inscription approuvée',
      ],
      footerText: `Connexion espace parent : ${loginUrl}`,
      signatureText: [
        'Service administratif',
        this.schoolDisplayName(),
        this.adminDisplayEmail(),
        this.adminPhone(),
      ].join('\n'),
      emergencyPhone: this.emergencyPhone(),
      schoolDisplayName: this.schoolDisplayName(),
    });

    if (!transport) {
      this.logger.warn(`E-mail approbation non envoyé (SMTP non configuré). Destinataire : ${params.to}`);
      return;
    }

    try {
      await transport.sendMail({
        from,
        to: params.to,
        subject,
        text,
        html,
        attachments: mailLogo.attachments.length ? mailLogo.attachments : undefined,
      });
      this.logger.log(`E-mail approbation envoyé à ${params.to}`);
      await this.notifications.notifyEmailSentToParentEmail(params.to, subject).catch(() => undefined);
    } catch (err) {
      this.logger.error(`Échec envoi e-mail approbation à ${params.to}`, err instanceof Error ? err.stack : err);
    }
  }

  /** Demande de signature de la fiche santé (espace parent). */
  async sendHealthSignatureRequest(params: HealthSignatureRequestMailParams): Promise<void> {
    const from =
      this.config.get<string>('MAIL_FROM')?.trim() || this.mailFromDefault();

    const transport = this.createTransport();
    const mailLogo = this.getMailLogo();
    const subjectBold = `Signature fiche santé — ${params.childName}`;
    const subject = `${this.schoolDisplayName()} — ${subjectBold}`;

    const displayName = params.parentName?.trim() || 'Parent';
    const greeting = params.parentName?.trim()
      ? `Bonjour ${escapeHtml(params.parentName.trim())},`
      : 'Bonjour,';

    const loginUrl = loginUrlFromConfig(this.config);

    const introHtml = `
      <p style="margin:0 0 12px;">${greeting}</p>
      <p style="margin:0 0 12px;">L’école vous invite à <strong>signer la fiche santé</strong> de <strong>${escapeHtml(params.childName)}</strong>.</p>
      <p style="margin:0;">Connectez-vous à votre espace parent pour consulter la fiche et déposer votre signature.</p>`;

    const recapRows: MailRecapRow[] = [
      { label: 'Élève concerné', value: escapeHtml(params.childName) },
      { label: 'Action attendue', value: 'Signature de la fiche santé', valueTone: 'blue' },
    ];

    const footerBodyHtml = `
      <p style="margin:0 0 12px;">Rendez-vous dans votre espace parent pour valider la fiche santé de votre enfant.</p>
      <p style="margin:0;"><a href="${escapeHtml(loginUrl)}" style="color:#216EC2;font-weight:600;">Se connecter à l’espace parent</a></p>`;

    const signatureBlockHtml = `
      <strong style="font-size:15px;">Service administratif</strong><br />
      ${escapeHtml(this.schoolDisplayName())}<br />
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
      logoUrl: mailLogo.logoUrl,
      adminPhone: this.adminPhone(),
      emergencyPhone: this.emergencyPhone(),
      schoolDisplayName: this.schoolDisplayName(),
    };

    const html = buildAdministrativeEmailHtml(layout);

    const text = buildAdministrativeEmailText({
      subjectBold,
      fromDisplay: this.adminDisplayEmail(),
      toLine: [params.to, displayName, params.parentPhone?.trim()].filter(Boolean).join(' · '),
      introText: [
        params.parentName?.trim() ? `Bonjour ${params.parentName.trim()},` : 'Bonjour,',
        '',
        `Merci de signer la fiche santé de ${params.childName}.`,
        '',
        `Connexion espace parent : ${loginUrl}`,
      ].join('\n'),
      recapLines: [`Élève concerné: ${params.childName}`, 'Action: Signature fiche santé'],
      footerText: `Connexion espace parent : ${loginUrl}`,
      signatureText: [
        'Service administratif',
        this.schoolDisplayName(),
        this.adminDisplayEmail(),
        this.adminPhone(),
      ].join('\n'),
      emergencyPhone: this.emergencyPhone(),
      schoolDisplayName: this.schoolDisplayName(),
    });

    if (!transport) {
      this.logger.warn(`E-mail fiche santé non envoyé (SMTP non configuré). Destinataire : ${params.to}`);
      return;
    }

    try {
      await transport.sendMail({
        from,
        to: params.to,
        subject,
        text,
        html,
        attachments: mailLogo.attachments.length ? mailLogo.attachments : undefined,
      });
      this.logger.log(`E-mail demande signature fiche santé envoyé à ${params.to}`);
      await this.notifications.notifyEmailSentToParentEmail(params.to, subject).catch(() => undefined);
    } catch (err) {
      this.logger.error(
        `Échec envoi e-mail fiche santé à ${params.to}`,
        err instanceof Error ? err.stack : err,
      );
    }
  }

  /** Relance lorsque le parent a plus de trois factures impayées (design identique à la messagerie administrative). */
  async sendParentMultipleUnpaidInvoicesReminder(params: MultipleUnpaidInvoicesMailParams): Promise<boolean> {
    const from =
      this.config.get<string>('MAIL_FROM')?.trim() || this.mailFromDefault();

    const transport = this.createTransport();
    const mailLogo = this.getMailLogo();
    const subjectBold = `Rappel de paiement — ${params.totalUnpaid} factures impayées`;
    const subject = `${this.schoolDisplayName()} — ${subjectBold}`;

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
      ${escapeHtml(this.schoolDisplayName())}<br />
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
      logoUrl: mailLogo.logoUrl,
      adminPhone: this.adminPhone(),
      emergencyPhone: this.emergencyPhone(),
      schoolDisplayName: this.schoolDisplayName(),
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
        this.schoolDisplayName(),
        this.adminDisplayEmail(),
        this.adminPhone(),
      ].join('\n'),
      emergencyPhone: this.emergencyPhone(),
      schoolDisplayName: this.schoolDisplayName(),
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
        attachments: mailLogo.attachments.length ? mailLogo.attachments : undefined,
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
      this.config.get<string>('MAIL_FROM')?.trim() || this.mailFromDefault();

    const loginUrl = loginUrlFromConfig(this.config);

    const transport = this.createTransport();
    const subject = `${this.schoolDisplayName()} — Votre espace parent`;

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
      this.schoolDisplayName(),
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
  <p>Cordialement,<br/>${escapeHtml(this.schoolDisplayName())}</p>
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

  /** Compte personnel admin créé ou mot de passe réinitialisé : gabarit messagerie administrative. */
  async sendStaffPortalCredentials(params: StaffPortalCredentialsParams): Promise<boolean> {
    const from =
      this.config.get<string>('MAIL_FROM')?.trim() || this.mailFromDefault();
    const loginUrl = adminLoginUrlFromConfig(this.config);
    const transport = this.createTransport();
    const mailLogo = this.getMailLogo();
    const isReset = Boolean(params.isPasswordReset);
    const subjectBold = isReset
      ? 'Réinitialisation de votre mot de passe — Espace de gestion'
      : 'Vos identifiants — Espace de gestion';
    const subject = `${this.schoolDisplayName()} — ${subjectBold}`;

    const displayName = params.fullName?.trim() || params.to;
    const greeting = params.fullName?.trim()
      ? `Bonjour ${escapeHtml(params.fullName.trim())},`
      : 'Bonjour,';

    const introHtml = isReset
      ? `<p style="margin:0 0 12px;">${greeting}</p>
      <p style="margin:0;">Votre mot de passe d’accès à l’<strong>espace de gestion</strong> a été réinitialisé par un administrateur. Utilisez les informations ci-dessous pour vous reconnecter.</p>`
      : `<p style="margin:0 0 12px;">${greeting}</p>
      <p style="margin:0;">Un compte vous a été ouvert sur l’<strong>espace de gestion</strong> de Commonwealth Preschool of Abidjan. Retrouvez ci-dessous vos identifiants de connexion.</p>`;

    const recapRows: MailRecapRow[] = [
      ...(params.jobTitle?.trim()
        ? [{ label: 'Poste / fonction', value: escapeHtml(params.jobTitle.trim()) }]
        : []),
      { label: 'Identifiant (e-mail)', value: escapeHtml(params.to) },
      {
        label: 'Mot de passe temporaire',
        value: `<span style="display:inline-block;margin-top:2px;padding:6px 12px;background:#ffffff;border:1px solid #cbd5e1;border-radius:8px;font-family:Consolas,Monaco,monospace;font-size:16px;font-weight:700;color:#0f172a;letter-spacing:0.06em;">${escapeHtml(params.password)}</span>`,
      },
      {
        label: 'Lien de connexion',
        value: `<a href="${escapeHtml(loginUrl)}" style="color:#216EC2;font-weight:700;text-decoration:none;">${escapeHtml(loginUrl)}</a>`,
      },
    ];

    const footerBodyHtml = `
      <div style="margin:0 0 20px;padding:14px 16px;background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;font-size:14px;line-height:1.6;color:#78350f;">
        <strong style="color:#92400e;display:block;margin-bottom:6px;">Important — sécurité du compte</strong>
        Lors de votre prochaine connexion, le système vous demandera de définir un <strong>nouveau mot de passe personnel</strong> avant d’utiliser l’application.
      </div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">
        <tr>
          <td align="center" style="border-radius:10px;background:#216EC2;">
            <a href="${escapeHtml(loginUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 32px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">Se connecter à l’espace de gestion</a>
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:13px;color:#64748b;line-height:1.65;">
        Conservez ce message en lieu sûr ou supprimez-le après votre première connexion. Pour toute assistance, contactez le service administratif aux coordonnées ci-dessous.
      </p>`;

    const signatureBlockHtml = `
      <strong style="font-size:15px;">Service administratif</strong><br />
      Commonwealth Preschool of Abidjan<br />
      <a href="mailto:${escapeHtml(this.adminDisplayEmail())}" style="color:#ffffff;text-decoration:underline;">${escapeHtml(this.adminDisplayEmail())}</a><br />
      ${escapeHtml(this.adminPhone())}`;

    const layout: AdministrativeMailContent = {
      fromDisplay: this.adminDisplayEmail(),
      toEmail: params.to,
      toDisplayName: displayName,
      toPhone: null,
      subjectBold,
      introHtml,
      recapRows,
      footerBodyHtml,
      signatureBlockHtml,
      logoUrl: mailLogo.logoUrl,
      adminPhone: this.adminPhone(),
      emergencyPhone: this.emergencyPhone(),
      schoolDisplayName: this.schoolDisplayName(),
    };

    const html = buildAdministrativeEmailHtml(layout);

    const introPlain = isReset
      ? 'Votre mot de passe d’accès à l’espace de gestion a été réinitialisé.'
      : 'Un compte vous a été créé sur l’espace de gestion Commonwealth.';

    const text = buildAdministrativeEmailText({
      subjectBold,
      fromDisplay: this.adminDisplayEmail(),
      toLine: [params.to, displayName].filter(Boolean).join(' · '),
      introText: [
        params.fullName?.trim() ? `Bonjour ${params.fullName.trim()},` : 'Bonjour,',
        '',
        introPlain,
        '',
      ].join('\n'),
      recapLines: [
        ...(params.jobTitle?.trim() ? [`Poste : ${params.jobTitle.trim()}`] : []),
        `Identifiant (e-mail) : ${params.to}`,
        `Mot de passe temporaire : ${params.password}`,
        `Connexion : ${loginUrl}`,
        '',
        'À la prochaine connexion, vous devrez choisir un nouveau mot de passe personnel.',
      ],
      footerText: 'Cordialement,',
      signatureText: `Service administratif — Commonwealth Preschool of Abidjan — ${this.adminDisplayEmail()} — ${this.adminPhone()}`,
      emergencyPhone: this.emergencyPhone(),
      schoolDisplayName: this.schoolDisplayName(),
    });

    if (!transport) {
      this.logger.warn(
        `E-mail identifiants personnel non envoyé (SMTP non configuré). Destinataire : ${params.to}`,
      );
      return false;
    }

    try {
      await transport.sendMail({
        from,
        to: params.to,
        subject,
        text,
        html,
        attachments: mailLogo.attachments.length ? mailLogo.attachments : undefined,
      });
      this.logger.log(`E-mail identifiants personnel envoyé à ${params.to}`);
      return true;
    } catch (err) {
      this.logger.error(
        `Échec envoi identifiants personnel à ${params.to}`,
        err instanceof Error ? err.stack : err,
      );
      return false;
    }
  }
}
