import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { EnrollmentStatus, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type SoftPayChannel = 'wave' | 'orange_money' | 'wizall' | 'mtn_money' | 'moov_money';
type PayableKind = 'TUITION' | 'MONTHLY_INSTALLMENT' | 'LEGACY';
type PayableBill = {
  kind: PayableKind;
  billId: string;
  childId: string;
  enrollmentId: string;
  amountCents: number;
  label: string;
  schoolYear?: string;
  year?: number;
  month?: number;
};

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

  private centsToXof(cents: number): number {
    const n = Number(cents);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.round(n / 100);
  }

  private isMonthlyInvoiceVisible(year: number, month: number, now = new Date()): boolean {
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    if (year < currentYear || (year === currentYear && month < currentMonth)) return true;
    if (year > currentYear || month > currentMonth) return false;
    const lastDay = new Date(year, month, 0).getDate();
    const thresholdDay = Math.max(1, lastDay - 9);
    return now.getDate() >= thresholdDay;
  }

  private periodKeyFromSchoolYear(schoolYear: string): number {
    const m = schoolYear.trim().match(/^(\d{4})-/);
    return m ? parseInt(m[1]!, 10) * 100 + 9 : 0;
  }

  extractPaydunyaCheckoutToken(checkout: Record<string, unknown>): string {
    const data = checkout?.data as Record<string, unknown> | undefined;
    const direct = String(checkout?.token ?? data?.token ?? '').trim();
    if (direct) return direct;
    const rt = checkout?.response_text ?? data?.response_text;
    if (typeof rt === 'object' && rt != null) {
      const o = rt as Record<string, unknown>;
      const nested = String(o.token ?? o.checkout_invoice_token ?? '').trim();
      if (nested) return nested;
    }
    if (typeof rt === 'string') {
      const m = rt.trim().match(/\/invoice\/([^/?#]+)/i);
      if (m?.[1]) return m[1].trim();
    }
    return '';
  }

  isPaydunyaCheckoutPaid(verify: Record<string, unknown>): boolean {
    const data = verify?.data as Record<string, unknown> | undefined;
    const inv = (data?.invoice ?? verify?.invoice) as Record<string, unknown> | undefined;
    const invStatus = String(inv?.status ?? '').toLowerCase();
    if (invStatus === 'completed' || invStatus === 'paid') return true;
    const rt = verify?.response_text;
    const rtObj = typeof rt === 'object' && rt != null ? (rt as Record<string, unknown>) : null;
    const statusRaw = String(
      verify?.status ??
        rtObj?.status ??
        rtObj?.payment_status ??
        data?.status ??
        '',
    ).toLowerCase();
    return (
      statusRaw.includes('completed') ||
      statusRaw.includes('paid') ||
      statusRaw.includes('successfully paid')
    );
  }

  private extractCustomData(verify: Record<string, unknown>): Record<string, string> {
    const data = verify?.data as Record<string, unknown> | undefined;
    const raw = (verify?.custom_data ?? data?.custom_data ?? {}) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw ?? {})) {
      if (v == null) continue;
      out[k] = String(v).trim();
    }
    return out;
  }

  private paydunyaInvoiceTotalXof(verify: Record<string, unknown>): number | null {
    const data = verify?.data as Record<string, unknown> | undefined;
    const inv = (data?.invoice ?? verify?.invoice) as Record<string, unknown> | undefined;
    const raw = inv?.total_amount ?? verify?.total_amount ?? data?.total_amount;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  private safeEqualHex(expectedHex: string, received: string): boolean {
    const a = Buffer.from(expectedHex, 'utf8');
    const b = Buffer.from(String(received).trim(), 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private channelToSoftpayProvider(channel: SoftPayChannel, dial: '+221' | '+225'): string {
    if (channel === 'wave') return dial === '+225' ? 'wave_ci' : 'wave_sn';
    if (channel === 'orange_money') return dial === '+225' ? 'orange_ci' : 'orange_sn';
    if (channel === 'wizall') {
      if (dial !== '+221') throw new BadRequestException('Wizall n’est disponible qu’au Sénégal.');
      return 'wizall_sn';
    }
    if (channel === 'mtn_money') {
      if (dial !== '+225') throw new BadRequestException('MTN Money n’est disponible qu’en Côte d’Ivoire.');
      return 'mtn_ci';
    }
    if (channel === 'moov_money') {
      if (dial !== '+225') throw new BadRequestException('Moov Money n’est disponible qu’en Côte d’Ivoire.');
      return 'moov_ci';
    }
    throw new BadRequestException('Moyen de paiement non supporté en ligne.');
  }

  private buildSoftpayPayload(
    provider: string,
    token: string,
    opts: { fullName: string; email: string; phoneLocalDigits: string; orangeOtp?: string },
  ): Record<string, unknown> {
    const fn = opts.fullName.trim() || 'Parent';
    const email = opts.email.trim() || 'parent@commonwealth-school.local';
    const local = opts.phoneLocalDigits.replace(/\D/g, '');

    switch (provider) {
      case 'wave_sn':
        return {
          wave_senegal_fullName: fn,
          wave_senegal_email: email,
          wave_senegal_phone: local,
          wave_senegal_payment_token: token,
        };
      case 'wave_ci':
        return {
          wave_ci_fullName: fn,
          wave_ci_email: email,
          wave_ci_phone: local,
          wave_ci_payment_token: token,
        };
      case 'orange_sn':
        return {
          customer_name: fn,
          customer_email: email,
          phone_number: local,
          invoice_token: token,
        };
      case 'orange_ci':
        return {
          orange_money_ci_customer_fullname: fn,
          orange_money_ci_email: email,
          orange_money_ci_phone_number: local.startsWith('0') ? local : `0${local}`,
          orange_money_ci_otp: String(opts.orangeOtp ?? '').trim(),
          payment_token: token,
        };
      case 'wizall_sn':
        return {
          customer_name: fn,
          customer_email: email,
          phone_number: local,
          invoice_token: token,
        };
      case 'mtn_ci':
        return {
          mtn_ci_customer_fullname: fn,
          mtn_ci_email: email,
          mtn_ci_phone_number: local,
          mtn_ci_wallet_provider: 'MTNCI',
          payment_token: token,
        };
      case 'moov_ci':
        return {
          moov_ci_customer_fullname: fn,
          moov_ci_email: email,
          moov_ci_phone_number: local,
          payment_token: token,
        };
      default:
        return { payment_token: token, invoice_token: token };
    }
  }

  private extractSoftpayRedirectUrl(soft: Record<string, unknown>): string {
    const other = (soft.other_url ?? (soft.data as Record<string, unknown> | undefined)?.other_url) as
      | Record<string, unknown>
      | undefined;
    const candidates = [
      soft.url,
      (soft.data as Record<string, unknown> | undefined)?.url,
      other?.om_url,
      other?.maxit_url,
    ];
    for (const c of candidates) {
      const s = String(c ?? '').trim();
      if (s.startsWith('http')) return s;
    }
    return '';
  }

  private extractWizallTransactionId(soft: Record<string, unknown>): string {
    const data = soft.data as Record<string, unknown> | undefined;
    return String(data?.TransactionID ?? soft.TransactionID ?? data?.transaction_id ?? '').trim();
  }

  private parseDial(raw: unknown): '+221' | '+225' {
    const s = String(raw ?? '').trim();
    if (s === '+225' || s.startsWith('+225') || s.startsWith('225')) return '+225';
    return '+221';
  }

  private parseChannel(raw: unknown): SoftPayChannel {
    const channel = String(raw ?? '').trim().toLowerCase();
    const allowed: SoftPayChannel[] = ['wave', 'orange_money', 'wizall', 'mtn_money', 'moov_money'];
    if (!allowed.includes(channel as SoftPayChannel)) {
      throw new BadRequestException('Moyen de paiement non reconnu.');
    }
    return channel as SoftPayChannel;
  }

  async resolveNextPayableBill(parentUserId: string, childIds: string[]): Promise<PayableBill> {
    const ids = [...new Set(childIds.map((x) => String(x ?? '').trim()).filter(Boolean))];
    const children = await this.prisma.child.findMany({
      where: {
        parentId: parentUserId,
        ...(ids.length ? { id: { in: ids } } : {}),
      },
      include: {
        enrollments: {
          where: { status: EnrollmentStatus.APPROVED },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
    if (!children.length) {
      throw new BadRequestException('Aucun élève autorisé pour ce paiement.');
    }

    const enrollmentIds = children
      .map((c) => c.enrollments[0]?.id)
      .filter((id): id is string => Boolean(id));
    if (!enrollmentIds.length) {
      throw new BadRequestException('Aucune inscription validée pour le paiement.');
    }

    const tuitions = await this.prisma.tuitionCharge.findMany({
      where: {
        enrollmentId: { in: enrollmentIds },
        status: PaymentStatus.PENDING,
        amountCents: { gt: 0 },
      },
      include: { enrollment: { select: { childId: true } } },
    });
    tuitions.sort(
      (a, b) => this.periodKeyFromSchoolYear(a.schoolYear) - this.periodKeyFromSchoolYear(b.schoolYear),
    );
    const tuition = tuitions[0];
    if (tuition) {
      return {
        kind: 'TUITION',
        billId: tuition.id,
        childId: tuition.enrollment.childId,
        enrollmentId: tuition.enrollmentId,
        amountCents: tuition.amountCents,
        label: `Scolarité ${tuition.schoolYear}`,
        schoolYear: tuition.schoolYear,
      };
    }

    const monthlies = await this.prisma.monthlyInstallment.findMany({
      where: {
        enrollmentId: { in: enrollmentIds },
        status: PaymentStatus.PENDING,
        totalAmountCents: { gt: 0 },
      },
      include: { enrollment: { select: { childId: true } } },
      orderBy: [{ year: 'asc' }, { month: 'asc' }],
    });
    const monthly = monthlies.find((m) => this.isMonthlyInvoiceVisible(m.year, m.month));
    if (monthly) {
      const tuitionStillDue = await this.hasPendingTuitionAnywhereForParent(parentUserId);
      if (tuitionStillDue) {
        throw new BadRequestException(
          'Réglez la scolarité annuelle pour tous les enfants avant de payer les mensualités.',
        );
      }
      return {
        kind: 'MONTHLY_INSTALLMENT',
        billId: monthly.id,
        childId: monthly.enrollment.childId,
        enrollmentId: monthly.enrollmentId,
        amountCents: monthly.totalAmountCents,
        label: `Mensualité ${String(monthly.month).padStart(2, '0')}/${monthly.year}`,
        year: monthly.year,
        month: monthly.month,
      };
    }

    const legacies = await this.prisma.monthlyPayment.findMany({
      where: {
        enrollmentId: { in: enrollmentIds },
        status: PaymentStatus.PENDING,
        amountCents: { gt: 0 },
      },
      include: { enrollment: { select: { childId: true } } },
      orderBy: [{ year: 'asc' }, { month: 'asc' }],
    });
    const legacy = legacies[0];
    if (legacy) {
      return {
        kind: 'LEGACY',
        billId: legacy.id,
        childId: legacy.enrollment.childId,
        enrollmentId: legacy.enrollmentId,
        amountCents: legacy.amountCents,
        label: `Mensualité ${String(legacy.month).padStart(2, '0')}/${legacy.year}`,
        year: legacy.year,
        month: legacy.month,
      };
    }

    throw new BadRequestException('Aucune facture impayée disponible pour paiement.');
  }

  async createParentCheckout(parentUserId: string, body: Record<string, unknown>) {
    const channel = this.parseChannel(body?.channel);
    const rawIds = body?.childIds;
    const childIds = Array.isArray(rawIds) ? rawIds.map((x) => String(x ?? '')) : [];
    const bill = await this.resolveNextPayableBill(parentUserId, childIds);
    const amountXof = this.centsToXof(bill.amountCents);
    if (amountXof <= 0) throw new BadRequestException('Montant de facture invalide.');

    const description = String(body?.description ?? '').trim() || `Commonwealth — ${bill.label}`;
    const created = (await this.createPaydunyaCheckoutInvoice({
      total_amount: amountXof,
      description,
      items: {
        item_0: {
          name: bill.label,
          quantity: '1',
          unit_price: String(amountXof),
          total_price: String(amountXof),
        },
      },
      custom_data: {
        parentId: parentUserId,
        childId: bill.childId,
        enrollmentId: bill.enrollmentId,
        billKind: bill.kind,
        billId: bill.billId,
        channel,
        amountCents: String(bill.amountCents),
        schoolYear: bill.schoolYear ?? '',
        year: bill.year != null ? String(bill.year) : '',
        month: bill.month != null ? String(bill.month) : '',
      },
    })) as Record<string, unknown>;

    const token = this.extractPaydunyaCheckoutToken(created);
    if (!token) {
      throw new BadGatewayException('PayDunya n’a pas renvoyé de token de paiement.');
    }
    return { token, amountXof, description, billKind: bill.kind, billId: bill.billId };
  }

  async triggerParentSoftpay(parentUserId: string, body: Record<string, unknown>) {
    const token = String(body?.checkoutToken ?? body?.token ?? '').trim();
    if (!token) throw new BadRequestException('Token de paiement manquant.');

    const verify = (await this.verifyPaydunyaCheckoutStatus(token)) as Record<string, unknown>;
    const custom = this.extractCustomData(verify);
    if (custom.parentId && custom.parentId !== parentUserId) {
      throw new ForbiddenException();
    }
    if (this.isPaydunyaCheckoutPaid(verify)) {
      return { success: true, paid: true, message: 'Paiement déjà confirmé.', redirectUrl: '', wizallTransactionId: '' };
    }

    const channel = this.parseChannel(body?.channel ?? custom.channel);
    const dial = this.parseDial(body?.country ?? body?.phoneCountry);
    const firstName = String(body?.firstName ?? '').trim();
    const lastName = String(body?.lastName ?? '').trim();
    const fullName = `${firstName} ${lastName}`.trim();
    const email = String(body?.email ?? '').trim();
    const phoneLocal = String(body?.phoneLocal ?? '').replace(/\D/g, '');
    const wizallCode = String(body?.wizallAuthorizationCode ?? body?.wizallOtp ?? '').trim();
    const wizallTxn = String(body?.wizallTransactionId ?? '').trim();

    if (channel === 'wizall' && wizallCode && wizallTxn) {
      const confirmed = (await this.callPaydunya('/softpay/wizall-money-senegal/confirm', {
        method: 'POST',
        headers: this.paydunyaHeaders(),
        body: JSON.stringify({
          authorization_code: wizallCode,
          phone_number: phoneLocal,
          transaction_id: wizallTxn,
        }),
      })) as Record<string, unknown>;
      const ok = confirmed.success !== false;
      if (!ok) {
        throw new BadGatewayException(
          String(confirmed.message ?? this.paydunyaPrimaryMessage(confirmed) ?? 'Confirmation Wizall refusée.'),
        );
      }
      return {
        success: true,
        paid: false,
        message: String(confirmed.message ?? 'Paiement Wizall en cours de confirmation.'),
        redirectUrl: '',
        wizallTransactionId: wizallTxn,
      };
    }

    const provider = this.channelToSoftpayProvider(channel, dial);
    if (provider === 'orange_ci' && !String(body?.orangeOtp ?? '').trim()) {
      throw new BadRequestException('Le code de paiement Orange Money CI est obligatoire.');
    }

    const payload = this.buildSoftpayPayload(provider, token, {
      fullName,
      email,
      phoneLocalDigits: phoneLocal,
      orangeOtp: String(body?.orangeOtp ?? '').trim(),
    });
    const soft = (await this.triggerPaydunyaSoftpay(provider, payload)) as Record<string, unknown>;
    if (soft.success === false) {
      throw new BadGatewayException(
        String(soft.message ?? this.paydunyaPrimaryMessage(soft) ?? 'La demande de paiement a été refusée.'),
      );
    }

    const redirectUrl = this.extractSoftpayRedirectUrl(soft);
    const wizallTransactionId = this.extractWizallTransactionId(soft);
    return {
      success: true,
      paid: false,
      message: String(soft.message ?? 'Demande de paiement envoyée.'),
      redirectUrl,
      wizallTransactionId,
      needsWizallOtp: channel === 'wizall' && Boolean(wizallTransactionId),
    };
  }

  async getParentCheckoutStatus(parentUserId: string, token: string) {
    const verify = (await this.verifyPaydunyaCheckoutStatus(token)) as Record<string, unknown>;
    const custom = this.extractCustomData(verify);
    if (custom.parentId && custom.parentId !== parentUserId) {
      throw new ForbiddenException();
    }
    return { paid: this.isPaydunyaCheckoutPaid(verify), status: verify };
  }

  private async findPaymentByPaydunyaToken(token: string): Promise<{
    kind: PayableKind;
    childId: string;
  } | null> {
    const where = { transactionRef: { contains: token } };
    const tuition = await this.prisma.tuitionCharge.findFirst({
      where,
      select: { enrollment: { select: { childId: true } } },
    });
    if (tuition) return { kind: 'TUITION', childId: tuition.enrollment.childId };
    const monthly = await this.prisma.monthlyInstallment.findFirst({
      where,
      select: { enrollment: { select: { childId: true } } },
    });
    if (monthly) return { kind: 'MONTHLY_INSTALLMENT', childId: monthly.enrollment.childId };
    const legacy = await this.prisma.monthlyPayment.findFirst({
      where,
      select: { enrollment: { select: { childId: true } } },
    });
    if (legacy) return { kind: 'LEGACY', childId: legacy.enrollment.childId };
    return null;
  }

  async applyPaidCheckoutToken(token: string, expectedParentId?: string) {
    const verify = (await this.verifyPaydunyaCheckoutStatus(token)) as Record<string, unknown>;
    if (!this.isPaydunyaCheckoutPaid(verify)) {
      throw new BadRequestException('Le paiement n’est pas encore confirmé par PayDunya.');
    }
    const custom = this.extractCustomData(verify);
    if (expectedParentId && custom.parentId && custom.parentId !== expectedParentId) {
      throw new ForbiddenException();
    }
    const parentUserId = expectedParentId || custom.parentId;
    if (!parentUserId) {
      throw new BadRequestException('Impossible d’associer ce paiement à un compte parent.');
    }

    const paidXof = this.paydunyaInvoiceTotalXof(verify);
    const expectedCents = Number(custom.amountCents ?? 0);
    if (paidXof != null && expectedCents > 0 && paidXof !== this.centsToXof(expectedCents)) {
      this.logger.warn(
        `PayDunya amount mismatch token=${token} paidXof=${paidXof} expectedCents=${expectedCents}`,
      );
      throw new BadRequestException('Le montant PayDunya ne correspond pas à la facture.');
    }

    const channel = String(custom.channel || 'online').toLowerCase();
    const transactionRef = `PAYDUNYA-${channel.toUpperCase()}-${token}`;

    const already = await this.findPaymentByPaydunyaToken(token);
    if (already) {
      return { ok: true, alreadyPaid: true, kind: already.kind, childId: already.childId };
    }

    let kind = String(custom.billKind || '').toUpperCase() as PayableKind;
    let enrollmentId = custom.enrollmentId;
    if (!enrollmentId || !kind) {
      const fallback = await this.resolveNextPayableBill(parentUserId, custom.childId ? [custom.childId] : []);
      if (paidXof != null && paidXof !== this.centsToXof(fallback.amountCents)) {
        throw new BadRequestException('Le montant PayDunya ne correspond pas à la facture.');
      }
      kind = fallback.kind;
      enrollmentId = fallback.enrollmentId;
      custom.billId = fallback.billId;
      custom.childId = fallback.childId;
      custom.schoolYear = fallback.schoolYear ?? '';
      custom.year = fallback.year != null ? String(fallback.year) : '';
      custom.month = fallback.month != null ? String(fallback.month) : '';
    }
    if (!enrollmentId) throw new BadRequestException('Facture PayDunya incomplète (inscription manquante).');

    if (kind === 'TUITION') {
      const charge = custom.billId
        ? await this.prisma.tuitionCharge.findFirst({
            where: { id: custom.billId, enrollmentId, enrollment: { child: { parentId: parentUserId } } },
          })
        : await this.prisma.tuitionCharge.findFirst({
            where: {
              enrollmentId,
              schoolYear: custom.schoolYear || undefined,
              enrollment: { child: { parentId: parentUserId } },
            },
          });
      if (!charge) throw new NotFoundException('Facture de scolarité introuvable.');
      if (charge.status === PaymentStatus.PAID) {
        return { ok: true, alreadyPaid: true, kind, childId: custom.childId };
      }
      await this.recordTuitionPayment({
        enrollmentId,
        schoolYear: charge.schoolYear,
        amountCents: charge.amountCents,
        transactionRef,
      });
      return { ok: true, kind, childId: custom.childId };
    }

    if (kind === 'MONTHLY_INSTALLMENT') {
      const year = Number(custom.year);
      const month = Number(custom.month);
      const row = custom.billId
        ? await this.prisma.monthlyInstallment.findFirst({
            where: { id: custom.billId, enrollmentId, enrollment: { child: { parentId: parentUserId } } },
          })
        : await this.prisma.monthlyInstallment.findFirst({
            where: { enrollmentId, year, month, enrollment: { child: { parentId: parentUserId } } },
          });
      if (!row) throw new NotFoundException('Mensualité introuvable.');
      if (row.status === PaymentStatus.PAID) {
        return { ok: true, alreadyPaid: true, kind, childId: custom.childId };
      }
      await this.recordMonthlyInstallmentPayment({
        enrollmentId,
        year: row.year,
        month: row.month,
        amountCents: row.totalAmountCents,
        transactionRef,
      });
      return { ok: true, kind, childId: custom.childId };
    }

    if (kind === 'LEGACY') {
      const year = Number(custom.year);
      const month = Number(custom.month);
      const row = custom.billId
        ? await this.prisma.monthlyPayment.findFirst({
            where: { id: custom.billId, enrollmentId, enrollment: { child: { parentId: parentUserId } } },
          })
        : null;
      if (row?.status === PaymentStatus.PAID) {
        return { ok: true, alreadyPaid: true, kind, childId: custom.childId };
      }
      await this.recordLegacyMonthlyPayment({
        enrollmentId,
        year: row?.year ?? year,
        month: row?.month ?? month,
        amountCents: row?.amountCents ?? expectedCents,
        transactionRef,
      });
      return { ok: true, kind, childId: custom.childId };
    }

    throw new BadRequestException('Type de facture PayDunya inconnu.');
  }

  async handlePaydunyaIpn(body: Record<string, unknown>) {
    const data = (
      body?.data && typeof body.data === 'object' ? body.data : body
    ) as Record<string, unknown>;
    const hash = String(data.hash ?? body.hash ?? '').trim();
    const master = String(process.env.PAYDUNYA_MASTER_KEY ?? '').trim();
    if (hash && master) {
      const expected = createHash('sha512').update(master).digest('hex');
      if (!this.safeEqualHex(expected, hash)) {
        this.logger.warn('PayDunya IPN: hash invalide');
        throw new UnauthorizedException();
      }
    }
    const invoice = (
      data.invoice && typeof data.invoice === 'object' ? data.invoice : {}
    ) as Record<string, unknown>;
    const token = String(invoice.token ?? data.token ?? data.invoice_token ?? body.token ?? '').trim();
    if (!token) {
      this.logger.warn('PayDunya IPN: token manquant');
      return { ok: true };
    }
    const status = String(data.status ?? invoice.status ?? '').toLowerCase();
    if (status && status !== 'completed' && status !== 'paid') {
      return { ok: true, ignored: status };
    }
    try {
      await this.applyPaidCheckoutToken(token);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`PayDunya IPN apply failed token=${token}: ${msg}`);
    }
    return { ok: true };
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
   * Espace parent : enregistre la facture après confirmation PayDunya (token obligatoire).
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
      kind?: PayableKind;
      message?: string;
    }>;
  }> {
    const checkoutToken = String(body?.checkoutToken ?? body?.token ?? '').trim();
    if (!checkoutToken) {
      throw new BadRequestException(
        'Le paiement n’a pas été confirmé par PayDunya. Validez d’abord sur Wave / Orange Money.',
      );
    }

    const applied = await this.applyPaidCheckoutToken(checkoutToken, parentUserId);
    const phone = String(body?.phone ?? '').trim();
    const channel = String(body?.channel ?? '').trim().toLowerCase() || 'online';

    return {
      channel,
      phone,
      recordedAt: new Date().toISOString(),
      results: [
        {
          childId: String(applied.childId ?? ''),
          ok: true,
          kind: applied.kind,
        },
      ],
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
        include: { lines: { orderBy: { sortOrder: 'asc' } } },
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
