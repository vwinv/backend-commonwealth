import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentStatus, type ParentRelation } from '@prisma/client';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import { PrismaService } from '../prisma/prisma.service';
import { readSchoolContact } from '../config/school-contact';
import {
  buildParentInvoiceHtml,
  formatXofFromCents,
  matriculeFromEnrollmentId,
  monthEndDateFr,
  schoolTrimesterFromMonth,
  stableInvoiceNumber,
  tuitionAnnualDueDateFr,
  type ParentInvoiceLine,
} from './parent-invoice-html';
import {
  buildParentReceiptHtml,
  formatPaymentModeFromTransactionRef,
  parseMedicalTags,
  stableReceiptNumber,
  type ParentReceiptLine,
} from './parent-receipt-html';

type BillingContact = {
  fullName: string | null;
  email: string;
  phone: string | null;
  address: string | null;
  parentRelation: ParentRelation | null;
};

const enrollmentChildSelect = {
  id: true,
  schoolYear: true,
  createdAt: true,
  level: { select: { name: true } },
  child: { select: { firstName: true, lastName: true, allergies: true } },
} as const;

@Injectable()
export class ParentInvoicePdfService {
  private readonly logger = new Logger(ParentInvoicePdfService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private branding() {
    const c = readSchoolContact(this.config);
    return {
      schoolDisplayName: c.displayName,
      contactEmail: c.contactEmail,
      emergencyPhone: c.emergencyPhone,
      administrationEmail: c.administrationEmail,
      paymentModesLine: c.paymentModes,
    };
  }

  /** Nest copie `src/mail/assets` vers `dist/mail/assets` ; le JS compilé est sous `dist/src/parent/`. */
  private resolveInvoiceLogoPath(): string | undefined {
    const cwd = process.cwd();
    const candidates = [
      join(__dirname, '..', 'mail', 'assets', 'logo.png'),
      join(__dirname, '..', '..', 'mail', 'assets', 'logo.png'),
      join(cwd, 'dist', 'mail', 'assets', 'logo.png'),
      join(cwd, 'src', 'mail', 'assets', 'logo.png'),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    return undefined;
  }

  private getLogoDataUri(): string | null {
    const p = this.resolveInvoiceLogoPath();
    if (!p) {
      this.logger.warn('Logo facture introuvable (aucun chemin candidat valide).');
      return null;
    }
    try {
      const buf = readFileSync(p);
      return `data:image/png;base64,${buf.toString('base64')}`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Logo facture introuvable: ${msg}`);
      return null;
    }
  }

  /** Chrome : cache Puppeteer, variable d’environnement, ou navigateur système courant. */
  private resolveChromeExecutablePath(): string | undefined {
    const fromEnv = this.config.get<string>('PUPPETEER_EXECUTABLE_PATH')?.trim();
    if (fromEnv && existsSync(fromEnv)) return fromEnv;

    try {
      const bundled = puppeteer.executablePath();
      if (bundled && existsSync(bundled)) return bundled;
    } catch {
      /* executablePath peut échouer si aucun build Puppeteer */
    }

    const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (process.platform === 'darwin' && existsSync(macChrome)) return macChrome;

    for (const p of [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ]) {
      if (existsSync(p)) return p;
    }

    return undefined;
  }

  private async loadBillingContact(userId: string): Promise<BillingContact> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        fullName: true,
        email: true,
        phone: true,
        address: true,
        parentRelation: true,
      },
    });
    if (!u) throw new NotFoundException('Compte introuvable');
    return {
      fullName: u.fullName,
      email: u.email?.trim() || '—',
      phone: u.phone,
      address: u.address,
      parentRelation: u.parentRelation,
    };
  }

  private childName(c: { firstName: string; lastName: string }): string {
    return `${c.firstName} ${c.lastName}`.trim();
  }

  private billedToTitle(contact: BillingContact): string {
    const name = contact.fullName?.trim() || 'Parent';
    if (contact.parentRelation === 'FATHER') return `M. ${name} (Père)`;
    if (contact.parentRelation === 'MOTHER') return `Mme ${name} (Mère)`;
    return name;
  }

  private billedAddress(contact: BillingContact): string {
    return contact.address?.trim() || '—';
  }

  private parentContactLine(contact: BillingContact): string {
    const parts = [contact.email?.trim(), contact.phone?.trim()].filter(Boolean);
    return parts.join(' · ') || '—';
  }

  private issueDateFr(iso?: Date | string): string {
    const d = iso ? new Date(iso) : new Date();
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  private async htmlToPdfBuffer(html: string): Promise<Buffer> {
    const executablePath = this.resolveChromeExecutablePath();
    if (!executablePath) {
      throw new InternalServerErrorException(
        'Chrome introuvable pour générer le PDF. En production (ex: Render), définissez PUPPETEER_SKIP_DOWNLOAD=true et PUPPETEER_EXECUTABLE_PATH vers un binaire Chrome/Chromium installé.',
      );
    }

    let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        executablePath,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Puppeteer launch: ${msg}`);
      throw new InternalServerErrorException(
        `Impossible de lancer Chrome pour le PDF (${msg}). Vérifiez PUPPETEER_EXECUTABLE_PATH (et en prod, PUPPETEER_SKIP_DOWNLOAD=true).`,
      );
    }

    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load', timeout: 45_000 });
      const buf = await page.pdf({
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
      });
      return Buffer.from(buf);
    } finally {
      await browser.close();
    }
  }

  private safeFilename(name: string): string {
    return name.replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_');
  }

  async tuitionPdf(
    userId: string,
    chargeId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const charge = await this.prisma.tuitionCharge.findFirst({
      where: {
        id: chargeId,
        enrollment: { child: { parentId: userId } },
      },
      include: {
        enrollment: { select: enrollmentChildSelect },
      },
    });
    if (!charge) throw new NotFoundException('Facture introuvable');

    const contact = await this.loadBillingContact(userId);
    const b = this.branding();
    const logoDataUri = this.getLogoDataUri();
    const levelName = charge.enrollment.level?.name?.trim() || '—';
    const y = Number(charge.schoolYear.trim().match(/^(\d{4})/)?.[1] ?? new Date().getFullYear());
    const inv = stableInvoiceNumber(y, charge.id);
    const lines: ParentInvoiceLine[] = [
      {
        description: `Frais de scolarité — ${levelName}`,
        qty: '1',
        unitPrice: formatXofFromCents(charge.amountCents),
        amount: formatXofFromCents(charge.amountCents),
      },
    ];
    const html = buildParentInvoiceHtml({
      documentTitle: 'Facture de scolarité',
      schoolDisplayName: b.schoolDisplayName,
      headerSubline: `${b.contactEmail} · Année scolaire ${charge.schoolYear}`,
      contactEmail: b.contactEmail,
      administrationEmail: b.administrationEmail,
      emergencyPhone: b.emergencyPhone,
      paymentModesLine: b.paymentModesLine,
      logoDataUri,
      invoiceNumber: inv,
      issueDateFr: this.issueDateFr(charge.createdAt),
      dueDateFr: tuitionAnnualDueDateFr(charge.schoolYear),
      schoolYearLine: `${charge.schoolYear} · Année complète`,
      studentNameWithLevel: `${this.childName(charge.enrollment.child)} — ${levelName}`,
      matriculeLine: `Matricule : ${matriculeFromEnrollmentId(charge.enrollment.id)}`,
      billedToTitle: this.billedToTitle(contact),
      billedAddress: this.billedAddress(contact),
      lines,
      totalAmount: formatXofFromCents(charge.amountCents),
      parentContactLine: this.parentContactLine(contact),
      generatedDateFr: this.issueDateFr(),
    });
    const buffer = await this.htmlToPdfBuffer(html);
    const filename = this.safeFilename(`Facture-scolarite-${inv}.pdf`);
    return { buffer, filename };
  }

  async monthlyPdf(
    userId: string,
    installmentId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const inst = await this.prisma.monthlyInstallment.findFirst({
      where: {
        id: installmentId,
        enrollment: { child: { parentId: userId } },
      },
      include: {
        enrollment: { select: enrollmentChildSelect },
        lines: { select: { label: true, amountCents: true } },
      },
    });
    if (!inst) throw new NotFoundException('Facture introuvable');

    const contact = await this.loadBillingContact(userId);
    const b = this.branding();
    const logoDataUri = this.getLogoDataUri();
    const levelName = inst.enrollment.level?.name?.trim() || '—';
    const inv = stableInvoiceNumber(inst.year, inst.id);
    const lines: ParentInvoiceLine[] = (inst.lines ?? []).map((l) => ({
      description: l.label,
      qty: '1',
      unitPrice: formatXofFromCents(l.amountCents),
      amount: formatXofFromCents(l.amountCents),
    }));
    if (!lines.length) {
      lines.push({
        description: `Mensualité — ${levelName}`,
        qty: '1',
        unitPrice: formatXofFromCents(inst.totalAmountCents),
        amount: formatXofFromCents(inst.totalAmountCents),
      });
    }
    const trim = schoolTrimesterFromMonth(inst.month);
    const html = buildParentInvoiceHtml({
      documentTitle: 'Facture de mensualité',
      schoolDisplayName: b.schoolDisplayName,
      headerSubline: `${b.contactEmail} · Année scolaire ${inst.enrollment.schoolYear}`,
      contactEmail: b.contactEmail,
      administrationEmail: b.administrationEmail,
      emergencyPhone: b.emergencyPhone,
      paymentModesLine: b.paymentModesLine,
      logoDataUri,
      invoiceNumber: inv,
      issueDateFr: this.issueDateFr(inst.createdAt),
      dueDateFr: monthEndDateFr(inst.year, inst.month),
      schoolYearLine: `${inst.enrollment.schoolYear} · Trimestre ${trim}`,
      studentNameWithLevel: `${this.childName(inst.enrollment.child)} — ${levelName}`,
      matriculeLine: `Matricule : ${matriculeFromEnrollmentId(inst.enrollment.id)}`,
      billedToTitle: this.billedToTitle(contact),
      billedAddress: this.billedAddress(contact),
      lines,
      totalAmount: formatXofFromCents(inst.totalAmountCents),
      parentContactLine: this.parentContactLine(contact),
      generatedDateFr: this.issueDateFr(),
    });
    const buffer = await this.htmlToPdfBuffer(html);
    const filename = this.safeFilename(`Facture-mensualite-${inv}.pdf`);
    return { buffer, filename };
  }

  async legacyPdf(
    userId: string,
    paymentId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const pay = await this.prisma.monthlyPayment.findFirst({
      where: {
        id: paymentId,
        enrollment: { child: { parentId: userId } },
      },
      include: {
        enrollment: { select: enrollmentChildSelect },
      },
    });
    if (!pay) throw new NotFoundException('Facture introuvable');

    const contact = await this.loadBillingContact(userId);
    const b = this.branding();
    const logoDataUri = this.getLogoDataUri();
    const levelName = pay.enrollment.level?.name?.trim() || '—';
    const cents = Number.isFinite(pay.amountCents) && pay.amountCents > 0 ? pay.amountCents : 0;
    const inv = stableInvoiceNumber(pay.year, pay.id);
    const lines: ParentInvoiceLine[] = [
      {
        description: `Ancienne facture mensuelle — ${levelName}`,
        qty: '1',
        unitPrice: formatXofFromCents(cents),
        amount: formatXofFromCents(cents),
      },
    ];
    const html = buildParentInvoiceHtml({
      documentTitle: 'Facture',
      schoolDisplayName: b.schoolDisplayName,
      headerSubline: `${b.contactEmail} · Année scolaire ${pay.enrollment.schoolYear}`,
      contactEmail: b.contactEmail,
      administrationEmail: b.administrationEmail,
      emergencyPhone: b.emergencyPhone,
      paymentModesLine: b.paymentModesLine,
      logoDataUri,
      invoiceNumber: inv,
      issueDateFr: this.issueDateFr(pay.createdAt),
      dueDateFr: monthEndDateFr(pay.year, pay.month),
      schoolYearLine: `${pay.enrollment.schoolYear} · Trimestre ${schoolTrimesterFromMonth(pay.month)}`,
      studentNameWithLevel: `${this.childName(pay.enrollment.child)} — ${levelName}`,
      matriculeLine: `Matricule : ${matriculeFromEnrollmentId(pay.enrollment.id)}`,
      billedToTitle: this.billedToTitle(contact),
      billedAddress: this.billedAddress(contact),
      lines,
      totalAmount: formatXofFromCents(cents),
      parentContactLine: this.parentContactLine(contact),
      generatedDateFr: this.issueDateFr(),
    });
    const buffer = await this.htmlToPdfBuffer(html);
    const filename = this.safeFilename(`Facture-${inv}.pdf`);
    return { buffer, filename };
  }

  async tuitionReceiptPdf(
    userId: string,
    chargeId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const charge = await this.prisma.tuitionCharge.findFirst({
      where: {
        id: chargeId,
        enrollment: { child: { parentId: userId } },
      },
      include: {
        enrollment: { select: enrollmentChildSelect },
      },
    });
    if (!charge) throw new NotFoundException('Reçu introuvable');
    if (charge.status !== PaymentStatus.PAID) {
      throw new BadRequestException('Le reçu est disponible uniquement après encaissement confirmé.');
    }

    const contact = await this.loadBillingContact(userId);
    const b = this.branding();
    const logoDataUri = this.getLogoDataUri();
    const levelName = charge.enrollment.level?.name?.trim() || '—';
    const yearInv = Number(charge.schoolYear.trim().match(/^(\d{4})/)?.[1] ?? new Date().getFullYear());
    const inv = stableInvoiceNumber(yearInv, charge.id);
    const rec = stableReceiptNumber(yearInv, charge.id);
    const lines: ParentReceiptLine[] = [
      {
        description: `Frais de scolarité — ${levelName}`,
        amount: formatXofFromCents(charge.amountCents),
      },
    ];
    const medicalTags = parseMedicalTags(charge.enrollment.child.allergies);
    const payDate = charge.paidAt ?? charge.updatedAt;
    const html = buildParentReceiptHtml({
      schoolDisplayName: b.schoolDisplayName,
      headerSubline: `${b.contactEmail} · Année scolaire ${charge.schoolYear}`,
      logoDataUri,
      receiptNumber: rec,
      studentNameWithLevel: `${this.childName(charge.enrollment.child)} — ${levelName}`,
      matriculeLine: `Matricule : ${matriculeFromEnrollmentId(charge.enrollment.id)}`,
      enrollmentDateFr: this.issueDateFr(charge.enrollment.createdAt),
      billedToTitle: this.billedToTitle(contact),
      billedAddress: this.billedAddress(contact),
      paymentDateFr: this.issueDateFr(payDate),
      paymentModeLine: formatPaymentModeFromTransactionRef(charge.transactionRef),
      amountHighlight: formatXofFromCents(charge.amountCents),
      settlementLine: `Montant reçu en règlement de la facture ${inv}`,
      lines,
      totalPaid: formatXofFromCents(charge.amountCents),
      administrationEmail: b.administrationEmail,
      emergencyPhone: b.emergencyPhone,
      generatedDateFr: this.issueDateFr(),
      medicalTags,
    });
    const buffer = await this.htmlToPdfBuffer(html);
    const filename = this.safeFilename(`Recu-paiement-${rec}.pdf`);
    return { buffer, filename };
  }

  async monthlyReceiptPdf(
    userId: string,
    installmentId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const inst = await this.prisma.monthlyInstallment.findFirst({
      where: {
        id: installmentId,
        enrollment: { child: { parentId: userId } },
      },
      include: {
        enrollment: { select: enrollmentChildSelect },
        lines: { select: { label: true, amountCents: true } },
      },
    });
    if (!inst) throw new NotFoundException('Reçu introuvable');
    if (inst.status !== PaymentStatus.PAID) {
      throw new BadRequestException('Le reçu est disponible uniquement après encaissement confirmé.');
    }

    const contact = await this.loadBillingContact(userId);
    const b = this.branding();
    const logoDataUri = this.getLogoDataUri();
    const levelName = inst.enrollment.level?.name?.trim() || '—';
    const inv = stableInvoiceNumber(inst.year, inst.id);
    const rec = stableReceiptNumber(inst.year, inst.id);
    const lines: ParentReceiptLine[] = (inst.lines ?? []).map((l) => ({
      description: l.label,
      amount: formatXofFromCents(l.amountCents),
    }));
    if (!lines.length) {
      lines.push({
        description: `Mensualité — ${levelName}`,
        amount: formatXofFromCents(inst.totalAmountCents),
      });
    }
    const medicalTags = parseMedicalTags(inst.enrollment.child.allergies);
    const payDate = inst.paidAt ?? inst.updatedAt;
    const html = buildParentReceiptHtml({
      schoolDisplayName: b.schoolDisplayName,
      headerSubline: `${b.contactEmail} · Année scolaire ${inst.enrollment.schoolYear}`,
      logoDataUri,
      receiptNumber: rec,
      studentNameWithLevel: `${this.childName(inst.enrollment.child)} — ${levelName}`,
      matriculeLine: `Matricule : ${matriculeFromEnrollmentId(inst.enrollment.id)}`,
      enrollmentDateFr: this.issueDateFr(inst.enrollment.createdAt),
      billedToTitle: this.billedToTitle(contact),
      billedAddress: this.billedAddress(contact),
      paymentDateFr: this.issueDateFr(payDate),
      paymentModeLine: formatPaymentModeFromTransactionRef(inst.transactionRef),
      amountHighlight: formatXofFromCents(inst.totalAmountCents),
      settlementLine: `Montant reçu en règlement de la facture ${inv}`,
      lines,
      totalPaid: formatXofFromCents(inst.totalAmountCents),
      administrationEmail: b.administrationEmail,
      emergencyPhone: b.emergencyPhone,
      generatedDateFr: this.issueDateFr(),
      medicalTags,
    });
    const buffer = await this.htmlToPdfBuffer(html);
    const filename = this.safeFilename(`Recu-paiement-${rec}.pdf`);
    return { buffer, filename };
  }

  async legacyReceiptPdf(
    userId: string,
    paymentId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const pay = await this.prisma.monthlyPayment.findFirst({
      where: {
        id: paymentId,
        enrollment: { child: { parentId: userId } },
      },
      include: {
        enrollment: { select: enrollmentChildSelect },
      },
    });
    if (!pay) throw new NotFoundException('Reçu introuvable');
    if (pay.status !== PaymentStatus.PAID) {
      throw new BadRequestException('Le reçu est disponible uniquement après encaissement confirmé.');
    }

    const contact = await this.loadBillingContact(userId);
    const b = this.branding();
    const logoDataUri = this.getLogoDataUri();
    const levelName = pay.enrollment.level?.name?.trim() || '—';
    const cents = Number.isFinite(pay.amountCents) && pay.amountCents > 0 ? pay.amountCents : 0;
    const inv = stableInvoiceNumber(pay.year, pay.id);
    const rec = stableReceiptNumber(pay.year, pay.id);
    const lines: ParentReceiptLine[] = [
      {
        description: `Ancienne facture mensuelle — ${levelName}`,
        amount: formatXofFromCents(cents),
      },
    ];
    const medicalTags = parseMedicalTags(pay.enrollment.child.allergies);
    const payDate = pay.paidAt ?? pay.updatedAt;
    const html = buildParentReceiptHtml({
      schoolDisplayName: b.schoolDisplayName,
      headerSubline: `${b.contactEmail} · Année scolaire ${pay.enrollment.schoolYear}`,
      logoDataUri,
      receiptNumber: rec,
      studentNameWithLevel: `${this.childName(pay.enrollment.child)} — ${levelName}`,
      matriculeLine: `Matricule : ${matriculeFromEnrollmentId(pay.enrollment.id)}`,
      enrollmentDateFr: this.issueDateFr(pay.enrollment.createdAt),
      billedToTitle: this.billedToTitle(contact),
      billedAddress: this.billedAddress(contact),
      paymentDateFr: this.issueDateFr(payDate),
      paymentModeLine: formatPaymentModeFromTransactionRef(pay.transactionRef),
      amountHighlight: formatXofFromCents(cents),
      settlementLine: `Montant reçu en règlement de la facture ${inv}`,
      lines,
      totalPaid: formatXofFromCents(cents),
      administrationEmail: b.administrationEmail,
      emergencyPhone: b.emergencyPhone,
      generatedDateFr: this.issueDateFr(),
      medicalTags,
    });
    const buffer = await this.htmlToPdfBuffer(html);
    const filename = this.safeFilename(`Recu-paiement-${rec}.pdf`);
    return { buffer, filename };
  }
}
