import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EnrollmentStatus, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private paydunyaBaseUrl() {
    return (process.env.PAYDUNYA_API_BASE ?? 'https://app.paydunya.com/api/v1').replace(/\/+$/, '');
  }

  private paydunyaHeaders() {
    const masterKey = String(process.env.PAYDUNYA_MASTER_KEY ?? '').trim();
    const privateKey = String(process.env.PAYDUNYA_PRIVATE_KEY ?? '').trim();
    const token = String(process.env.PAYDUNYA_TOKEN ?? '').trim();
    if (!masterKey || !privateKey || !token) {
      throw new BadRequestException('Configuration PayDunya incomplète (MASTER_KEY, PRIVATE_KEY, TOKEN).');
    }
    return {
      'Content-Type': 'application/json',
      'PAYDUNYA-MASTER-KEY': masterKey,
      'PAYDUNYA-PRIVATE-KEY': privateKey,
      'PAYDUNYA-TOKEN': token,
    };
  }

  /** Réponse « créer facture » exploitable côté client (token racine ou URL contenant `/invoice/{token}`). */
  private paydunyaCheckoutCreateHasToken(body: unknown): boolean {
    if (!body || typeof body !== 'object') return false;
    const b = body as Record<string, unknown>;
    if (String(b.token ?? '').trim().length > 0) return true;
    const data = b.data as Record<string, unknown> | undefined;
    if (data && String(data.token ?? '').trim().length > 0) return true;
    const rt = b.response_text ?? data?.response_text;
    if (typeof rt === 'string' && /\/invoice\/[^/?#]+/i.test(rt)) return true;
    return false;
  }

  private paydunyaNormalizedResponseCode(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const rc = (body as Record<string, unknown>).response_code;
    if (rc === undefined || rc === null) return null;
    return String(rc).trim();
  }

  /** Message lisible renvoyé par PayDunya (priorité à `response_text`). */
  private paydunyaPrimaryMessage(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const b = body as Record<string, unknown>;
    const pick = (v: unknown): string | null => {
      if (typeof v !== 'string') return null;
      const t = v.trim();
      return t.length ? t : null;
    };
    const rt = pick(b.response_text);
    if (rt) return rt;
    const data = b.data as Record<string, unknown> | undefined;
    if (data) {
      const drt = pick(data.response_text);
      if (drt) return drt;
    }
    const desc = pick(b.description);
    if (desc) return desc;
    const msg = b.message;
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
    if (Array.isArray(msg) && msg.length) return msg.map(String).join('; ');
    return null;
  }

  private formatPaydunyaHttpError(status: number, json: any, raw: string): string {
    const primary = this.paydunyaPrimaryMessage(json);
    if (primary) return primary;
    if (raw && raw.length < 500) return raw.trim() || `HTTP ${status}`;
    return `HTTP ${status}`;
  }

  private async callPaydunya(path: string, init?: RequestInit) {
    const url = `${this.paydunyaBaseUrl()}${path}`;
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      this.logger.warn(`PayDunya fetch failed ${path}: ${err}`);
      throw new BadGatewayException(
        `Impossible de joindre PayDunya (${this.paydunyaBaseUrl()}). Vérifiez le réseau et PAYDUNYA_API_BASE (ex. sandbox: …/sandbox-api/v1). Détail : ${err}`,
      );
    }
    const raw = await res.text();
    let json: any = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = { raw };
    }
    if (!res.ok) {
      const msg = this.formatPaydunyaHttpError(res.status, json, raw);
      this.logger.warn(`PayDunya HTTP ${res.status} ${path}: ${msg}`);
      throw new BadGatewayException(msg);
    }
    return json;
  }

  async createPaydunyaCheckoutInvoice(body: Record<string, unknown>) {
    const payload = {
      invoice: {
        total_amount: Number(body?.total_amount ?? body?.amount ?? 0),
        description: String(body?.description ?? ''),
        items: body?.items ?? {},
        taxes: body?.taxes ?? {},
      },
      store: {
        name: String(body?.store_name ?? process.env.PAYDUNYA_STORE_NAME ?? 'COMMONWEALTH'),
        tagline: String(body?.store_tagline ?? process.env.PAYDUNYA_STORE_TAGLINE ?? ''),
        postal_address: String(body?.store_postal_address ?? process.env.PAYDUNYA_STORE_POSTAL_ADDRESS ?? ''),
        phone: String(body?.store_phone ?? process.env.PAYDUNYA_STORE_PHONE ?? ''),
        logo_url: String(body?.store_logo_url ?? process.env.PAYDUNYA_STORE_LOGO_URL ?? ''),
        website_url: String(body?.store_website_url ?? process.env.PAYDUNYA_STORE_WEBSITE_URL ?? ''),
      },
      custom_data: body?.custom_data ?? {},
      actions: {
        callback_url: String(body?.callback_url ?? process.env.PAYDUNYA_CALLBACK_URL ?? ''),
      },
    };
    if (!Number.isFinite(payload.invoice.total_amount) || payload.invoice.total_amount <= 0) {
      throw new BadRequestException('total_amount doit être un nombre positif.');
    }
    if (!payload.store.name) {
      throw new BadRequestException('store.name est obligatoire.');
    }
    const created = await this.callPaydunya('/checkout-invoice/create', {
      method: 'POST',
      headers: this.paydunyaHeaders(),
      body: JSON.stringify(payload),
    });
    const hasToken = this.paydunyaCheckoutCreateHasToken(created);
    const rc = this.paydunyaNormalizedResponseCode(created);
    const rcOk = rc === null || rc === '00' || rc === '0';
    if (hasToken && rcOk) {
      return created;
    }
    if (hasToken && !rcOk) {
      this.logger.warn(`PayDunya checkout-invoice: token présent mais response_code=${rc}, on poursuit.`);
      return created;
    }
    if (!rcOk) {
      const msg =
        this.paydunyaPrimaryMessage(created) ??
        `PayDunya a refusé la création de facture (response_code=${rc ?? '?'})`;
      this.logger.warn(`PayDunya checkout-invoice refusé: ${JSON.stringify(created)?.slice(0, 800)}`);
      throw new BadGatewayException(String(msg));
    }
    this.logger.warn(`PayDunya checkout-invoice: réponse sans token exploitable: ${JSON.stringify(created)?.slice(0, 800)}`);
    const fallbackNoToken =
      this.paydunyaPrimaryMessage(created) ??
      'Réponse PayDunya sans token de facture exploitable. Vérifiez les clés et PAYDUNYA_API_BASE (test vs production).';
    throw new BadGatewayException(String(fallbackNoToken));
  }

  async triggerPaydunyaSoftpay(
    provider: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const map: Record<string, string> = {
      wave_sn: '/softpay/wave-senegal',
      /** Doc PayDunya : `/api/v1/softpay/wave-ci` */
      wave_ci: '/softpay/wave-ci',
      orange_sn: '/softpay/new-orange-money-senegal',
      /** Doc PayDunya : `/api/v1/softpay/orange-money-ci` */
      orange_ci: '/softpay/orange-money-ci',
      free_sn: '/softpay/free-money-senegal',
      wizall_sn: '/softpay/wizall-money-senegal',
      mtn_ci: '/softpay/mtn-ci',
      moov_ci: '/softpay/moov-ci',
      paydunya: '/softpay/paydunya',
    };
    const key = String(provider ?? '').trim().toLowerCase();
    const endpoint = map[key];
    if (!endpoint) throw new BadRequestException('Provider SoftPay non supporté.');
    return this.callPaydunya(endpoint, {
      method: 'POST',
      headers: this.paydunyaHeaders(),
      body: JSON.stringify(body ?? {}),
    });
  }

  async verifyPaydunyaCheckoutStatus(token: string) {
    const clean = String(token ?? '').trim();
    if (!clean) throw new BadRequestException('token requis');
    return this.callPaydunya(`/checkout-invoice/confirm/${encodeURIComponent(clean)}`, {
      method: 'GET',
      headers: this.paydunyaHeaders(),
    });
  }

  async recordPayment(input: any) {
    const kind = String(input?.kind ?? 'LEGACY').toUpperCase();
    if (kind === 'TUITION') return this.recordTuitionPayment(input);
    if (kind === 'MONTHLY_INSTALLMENT') return this.recordMonthlyInstallmentPayment(input);
    return this.recordLegacyMonthlyPayment(input);
  }

  /** Tant qu’au moins une scolarité annuelle est impayée pour un enfant du parent, les mensualités ne sont pas encaissées. */
  private async hasPendingTuitionAnywhereForParent(parentUserId: string): Promise<boolean> {
    const n = await this.prisma.tuitionCharge.count({
      where: {
        status: PaymentStatus.PENDING,
        amountCents: { gt: 0 },
        enrollment: {
          status: EnrollmentStatus.APPROVED,
          child: { parentId: parentUserId },
        },
      },
    });
    return n > 0;
  }

  private async assertEnrollmentApproved(enrollmentId: string) {
    const e = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      select: { status: true },
    });
    if (!e) throw new NotFoundException('Enrollment not found');
    if (e.status !== EnrollmentStatus.APPROVED) {
      throw new BadRequestException('Le paiement n’est possible qu’après validation de l’inscription');
    }
  }

  private async recordTuitionPayment(input: any) {
    const enrollmentId = String(input?.enrollmentId ?? '').trim();
    const schoolYear = input?.schoolYear != null ? String(input.schoolYear).trim() : '';
    if (!enrollmentId) throw new BadRequestException('enrollmentId is required');

    await this.assertEnrollmentApproved(enrollmentId);

    const charge = schoolYear
      ? await this.prisma.tuitionCharge.findUnique({
          where: { enrollmentId_schoolYear: { enrollmentId, schoolYear } },
        })
      : await this.prisma.tuitionCharge.findFirst({
          where: { enrollmentId },
          orderBy: { createdAt: 'desc' },
        });

    if (!charge) {
      throw new NotFoundException('Aucune échéance de scolarité annuelle pour cette inscription');
    }
    if (charge.status === PaymentStatus.PAID) {
      throw new BadRequestException('La scolarité annuelle est déjà réglée');
    }

    const amountCents = input?.amountCents != null ? Number(input.amountCents) : charge.amountCents;
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new BadRequestException('amountCents must be a positive integer');
    }
    if (amountCents !== charge.amountCents) {
      throw new BadRequestException(`Montant attendu : ${charge.amountCents} centimes`);
    }

    const transactionRef = input?.transactionRef ? String(input.transactionRef).trim() : undefined;

    return this.prisma.tuitionCharge.update({
      where: { id: charge.id },
      data: {
        status: PaymentStatus.PAID,
        paidAt: new Date(),
        transactionRef,
      },
    });
  }

  private async recordMonthlyInstallmentPayment(input: any) {
    const enrollmentId = String(input?.enrollmentId ?? '').trim();
    const year = Number(input?.year);
    const month = Number(input?.month);
    if (!enrollmentId) throw new BadRequestException('enrollmentId is required');
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year must be a valid integer');
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new BadRequestException('month must be between 1 and 12');
    }

    await this.assertEnrollmentApproved(enrollmentId);

    const row = await this.prisma.monthlyInstallment.findUnique({
      where: { enrollmentId_year_month: { enrollmentId, year, month } },
    });
    if (!row) {
      throw new NotFoundException('Aucune mensualité générée pour cette période');
    }
    if (row.status === PaymentStatus.PAID) {
      throw new BadRequestException('Cette mensualité est déjà réglée');
    }

    const amountCents = input?.amountCents != null ? Number(input.amountCents) : row.totalAmountCents;
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new BadRequestException('amountCents must be a positive integer');
    }
    if (amountCents !== row.totalAmountCents) {
      throw new BadRequestException(`Montant attendu : ${row.totalAmountCents} centimes`);
    }

    const transactionRef = input?.transactionRef ? String(input.transactionRef).trim() : undefined;

    return this.prisma.monthlyInstallment.update({
      where: { id: row.id },
      data: {
        status: PaymentStatus.PAID,
        paidAt: new Date(),
        transactionRef,
      },
    });
  }

  private async recordLegacyMonthlyPayment(input: any) {
    const enrollmentId = String(input?.enrollmentId ?? '').trim();
    if (!enrollmentId) throw new BadRequestException('enrollmentId is required');

    const year = Number(input?.year);
    const month = Number(input?.month);
    const amountCents = Number(input?.amountCents);

    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year must be a valid integer');
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new BadRequestException('month must be between 1 and 12');
    }
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new BadRequestException('amountCents must be a positive integer');
    }

    const transactionRef = input?.transactionRef ? String(input.transactionRef).trim() : undefined;

    try {
      return await this.prisma.monthlyPayment.upsert({
        where: {
          enrollmentId_year_month: { enrollmentId, year, month },
        },
        update: {
          amountCents,
          status: PaymentStatus.PAID,
          paidAt: new Date(),
          transactionRef,
        },
        create: {
          enrollmentId,
          year,
          month,
          amountCents,
          status: PaymentStatus.PAID,
          paidAt: new Date(),
          transactionRef,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
        throw new NotFoundException('Enrollment not found');
      }
      throw e;
    }
  }

  /**
   * Espace parent : enregistre le paiement pour chaque enfant sélectionné (scolarité annuelle en priorité,
   * sinon prochaine mensualité impayée). À appeler après confirmation côté passerelle (ou en simulation).
   */
  async completeParentSchoolFees(
    parentUserId: string,
    body: Record<string, unknown>,
  ): Promise<{
    channel: string;
    phone: string;
    recordedAt: string;
    results: Array<{
      childId: string;
      ok: boolean;
      kind?: 'TUITION' | 'MONTHLY_INSTALLMENT';
      message?: string;
    }>;
  }> {
    const rawIds = body?.childIds;
    const childIds = Array.isArray(rawIds)
      ? [...new Set(rawIds.map((x) => String(x ?? '').trim()).filter(Boolean))]
      : [];
    const phone = String(body?.phone ?? '').trim();
    const channel = String(body?.channel ?? '').trim().toLowerCase();

    if (!childIds.length) {
      throw new BadRequestException('Sélectionnez au moins un élève.');
    }
    if (!phone) {
      throw new BadRequestException('Le numéro de téléphone est obligatoire.');
    }
    if (!channel) {
      throw new BadRequestException('Le moyen de paiement est obligatoire.');
    }

    const allowed = new Set(['wave', 'orange_money', 'wizall', 'western_union', 'mtn_money', 'moov_money']);
    if (!allowed.has(channel)) {
      throw new BadRequestException('Moyen de paiement non reconnu.');
    }

    const refPrefix = `SIM-${channel.toUpperCase()}-${Date.now()}`;
    const results: Array<{
      childId: string;
      ok: boolean;
      kind?: 'TUITION' | 'MONTHLY_INSTALLMENT';
      message?: string;
    }> = [];

    for (const childId of childIds) {
      const child = await this.prisma.child.findFirst({
        where: { id: childId, parentId: parentUserId },
        include: {
          enrollments: {
            where: { status: EnrollmentStatus.APPROVED },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      });

      if (!child) {
        results.push({ childId, ok: false, message: 'Élève introuvable ou non autorisé.' });
        continue;
      }

      const enrollment = child.enrollments[0];
      if (!enrollment) {
        results.push({ childId, ok: false, message: 'Aucune inscription validée pour cet élève.' });
        continue;
      }

      const tuition = await this.prisma.tuitionCharge.findFirst({
        where: { enrollmentId: enrollment.id, status: PaymentStatus.PENDING },
        orderBy: { schoolYear: 'desc' },
      });

      if (tuition && tuition.amountCents > 0) {
        const transactionRef = `${refPrefix}-${childId.slice(0, 8)}-T`;
        try {
          await this.recordTuitionPayment({
            enrollmentId: enrollment.id,
            schoolYear: tuition.schoolYear,
            amountCents: tuition.amountCents,
            transactionRef,
          });
          results.push({ childId, ok: true, kind: 'TUITION' });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          results.push({ childId, ok: false, message: msg });
        }
        continue;
      }

      const monthly = await this.prisma.monthlyInstallment.findFirst({
        where: { enrollmentId: enrollment.id, status: PaymentStatus.PENDING },
        orderBy: [{ year: 'asc' }, { month: 'asc' }],
      });

      if (monthly && monthly.totalAmountCents > 0) {
        const tuitionStillDueSomewhere = await this.hasPendingTuitionAnywhereForParent(parentUserId);
        if (tuitionStillDueSomewhere) {
          results.push({
            childId,
            ok: false,
            message:
              'Réglez la scolarité annuelle pour tous les enfants avant de payer les mensualités.',
          });
          continue;
        }
        const transactionRef = `${refPrefix}-${childId.slice(0, 8)}-M`;
        try {
          await this.recordMonthlyInstallmentPayment({
            enrollmentId: enrollment.id,
            year: monthly.year,
            month: monthly.month,
            amountCents: monthly.totalAmountCents,
            transactionRef,
          });
          results.push({ childId, ok: true, kind: 'MONTHLY_INSTALLMENT' });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          results.push({ childId, ok: false, message: msg });
        }
        continue;
      }

      results.push({
        childId,
        ok: false,
        message: 'Aucune échéance impayée pour cet élève.',
      });
    }

    const anyOk = results.some((r) => r.ok);
    if (!anyOk) {
      const firstMsg = results.find((r) => r.message)?.message ?? 'Aucun paiement enregistré.';
      throw new BadRequestException(firstMsg);
    }

    return {
      channel,
      phone,
      recordedAt: new Date().toISOString(),
      results,
    };
  }

  async listEnrollmentPayments(enrollmentId: string) {
    const exists = await this.prisma.enrollment.findUnique({ where: { id: enrollmentId }, select: { id: true } });
    if (!exists) throw new NotFoundException('Enrollment not found');

    const [legacyMonthly, tuitionCharges, monthlyInstallments] = await Promise.all([
      this.prisma.monthlyPayment.findMany({
        where: { enrollmentId },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
      }),
      this.prisma.tuitionCharge.findMany({
        where: { enrollmentId },
        orderBy: { schoolYear: 'desc' },
      }),
      this.prisma.monthlyInstallment.findMany({
        where: { enrollmentId },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        include: { lines: { include: { serviceTariff: true } } },
      }),
    ]);

    return { legacyMonthly, tuitionCharges, monthlyInstallments };
  }
}
