import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EnrollmentStatus, Gender, ParentRelation, Prisma } from '@prisma/client';
import { BillingService } from '../billing/billing.service';
import { parsePublicHealthInput, upsertChildHealthRecordInTx } from '../enrollments/enrollment-health.util';
import { parseWizardData, type EnrollmentWizardData } from '../enrollments/enrollment-wizard.util';
import { EnrollmentsService } from '../enrollments/enrollments.service';
import { MailService } from '../mail/mail.service';
import { stripTechnicalIds } from '../mail/mail-layout';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

function formatSchoolYearLabel(schoolYear: string): string {
  const s = schoolYear.trim();
  if (s.includes('-') && s.length >= 9) return s.replace(/(\d{4})-(\d{4})/, '$1 - $2');
  return s;
}

function ageLabelDetailed(birthDate: Date | null): string {
  if (!birthDate) return '—';
  const now = new Date();
  let months =
    (now.getFullYear() - birthDate.getFullYear()) * 12 + (now.getMonth() - birthDate.getMonth());
  if (now.getDate() < birthDate.getDate()) months -= 1;
  if (months < 0) return '—';
  if (months < 12) {
    if (months === 0) return '< 1 mois';
    return `${months} mois`;
  }
  const years = Math.floor(months / 12);
  return `${years} an${years > 1 ? 's' : ''}`;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown, max = 500): string {
  return String(v ?? '')
    .trim()
    .slice(0, max);
}

function optStr(v: unknown, max = 500): string | undefined {
  const s = str(v, max);
  return s || undefined;
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function isoDay(d: Date | null | undefined): string {
  if (!d) return '';
  return d.toISOString().slice(0, 10);
}

function parseGenderInput(raw: unknown): Gender {
  const genderRaw = String(raw ?? '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  if (genderRaw === 'FEMALE' || genderRaw === 'FILLE') return Gender.FEMALE;
  if (genderRaw === 'MALE' || genderRaw === 'GARCON') return Gender.MALE;
  return Gender.UNSPECIFIED;
}

function parseParentRelationInput(raw: unknown): ParentRelation | null {
  const s = String(raw ?? '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  if (s === 'FATHER' || s === 'PERE') return ParentRelation.FATHER;
  if (s === 'MOTHER' || s === 'MERE') return ParentRelation.MOTHER;
  return null;
}

function parseBirthDateInput(raw: unknown): Date | null {
  const birthDateRaw = String(raw ?? '').trim();
  if (!birthDateRaw) return null;
  const birthDate = new Date(birthDateRaw);
  if (Number.isNaN(birthDate.getTime())) {
    throw new BadRequestException('La date de naissance est invalide.');
  }
  return birthDate;
}

function splitFullName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first: parts[0] ?? '', last: '' };
  return { first: parts[0]!, last: parts.slice(1).join(' ') };
}

function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function genderLabelFr(g: Gender): string {
  if (g === Gender.FEMALE) return 'Fille';
  if (g === Gender.MALE) return 'Garçon';
  return 'Non précisé';
}

function relationLabelFr(r: ParentRelation | null | undefined): string {
  if (r === ParentRelation.FATHER) return 'Père';
  if (r === ParentRelation.MOTHER) return 'Mère';
  return '—';
}

function yn(v: boolean): string {
  return v ? 'Oui' : 'Non';
}

@Injectable()
export class AdminEnrollmentsService {
  private readonly logger = new Logger(AdminEnrollmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrollmentsCore: EnrollmentsService,
    private readonly billing: BillingService,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
  ) {}

  async getStats() {
    const [total, pending, approved, rejected] = await Promise.all([
      this.prisma.enrollment.count(),
      this.prisma.enrollment.count({ where: { status: EnrollmentStatus.PENDING } }),
      this.prisma.enrollment.count({ where: { status: EnrollmentStatus.APPROVED } }),
      this.prisma.enrollment.count({ where: { status: EnrollmentStatus.REJECTED } }),
    ]);
    return { total, pending, approved, rejected };
  }

  async listPage(params: {
    page: number;
    limit: number;
    search?: string;
    sort?: string;
  }) {
    const page = Math.max(1, params.page);
    const limit = Math.min(100, Math.max(1, params.limit));
    const skip = (page - 1) * limit;

    const search = params.search?.trim();
    const where: Prisma.EnrollmentWhereInput = {};
    if (search) {
      where.OR = [
        { child: { firstName: { contains: search, mode: 'insensitive' } } },
        { child: { lastName: { contains: search, mode: 'insensitive' } } },
      ];
    }

    let orderBy:
      | Prisma.EnrollmentOrderByWithRelationInput
      | Prisma.EnrollmentOrderByWithRelationInput[] = { createdAt: 'desc' };
    const sort = params.sort?.trim();
    if (sort === 'date_asc') {
      orderBy = { createdAt: 'asc' };
    } else if (sort === 'name_asc') {
      orderBy = [
        { child: { lastName: 'asc' } },
        { child: { firstName: 'asc' } },
      ];
    } else if (sort === 'name_desc') {
      orderBy = [
        { child: { lastName: 'desc' } },
        { child: { firstName: 'desc' } },
      ];
    }

    const [totalFiltered, rows] = await Promise.all([
      this.prisma.enrollment.count({ where }),
      this.prisma.enrollment.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          child: true,
          level: true,
          class: true,
        },
      }),
    ]);

    const items = rows.map((e) => ({
      id: e.id,
      date: e.createdAt.toISOString(),
      studentName: `${e.child.firstName} ${e.child.lastName}`.trim(),
      age: ageLabelDetailed(e.child.birthDate),
      className: e.class?.name ?? e.level.name,
      schoolYear: formatSchoolYearLabel(e.schoolYear),
      status: e.status,
    }));

    return {
      items,
      total: totalFiltered,
      page,
      limit,
    };
  }

  /** Stats + page en un appel (écran Gestion des inscriptions). */
  async getOverview(query: {
    page?: number;
    limit?: number;
    search?: string;
    sort?: string;
  }) {
    const [stats, pageData] = await Promise.all([
      this.getStats(),
      this.listPage({
        page: query.page ?? 1,
        limit: query.limit ?? 10,
        search: query.search,
        sort: query.sort,
      }),
    ]);
    return { stats, ...pageData };
  }

  /** Détail inscription + cartes KPI (écran suivi). */
  async getOneWithStats(id: string) {
    const [stats, enrollment] = await Promise.all([
      this.getStats(),
      this.enrollmentsCore.getOne(id),
    ]);
    return { stats, enrollment };
  }

  /**
   * Correction d’un dossier encore en attente de validation.
   * Chaque enregistrement notifie le parent (e-mail éditable + notification in-app).
   */
  async updatePendingDossier(id: string, body: Record<string, unknown>) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id },
      include: {
        child: {
          include: {
            parent: true,
            healthRecord: { include: { vaccinations: { orderBy: { createdAt: 'asc' } } } },
          },
        },
        level: true,
        schedule: true,
        serviceSubscriptions: { include: { serviceTariff: true, variant: true } },
      },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found');
    if (enrollment.status !== EnrollmentStatus.PENDING) {
      throw new BadRequestException(
        'Seuls les dossiers en attente de validation peuvent être modifiés.',
      );
    }

    const childIn = asObj(body.child) ?? {};
    const parentIn = asObj(body.parent) ?? {};
    const guardian2In = asObj(body.guardian2);
    const emergencyIn = asObj(body.emergency);
    const healthIn = asObj(body.health);
    const optionsIn = asObj(body.options) ?? {};
    const notifyIn = asObj(body.notify);
    if (!notifyIn) {
      throw new BadRequestException('Le message de notification au parent est obligatoire.');
    }

    const notifySubject = stripTechnicalIds(str(notifyIn.subject, 200)).trim();
    const notifyBody = stripTechnicalIds(str(notifyIn.body, 12000)).trim();
    if (!notifySubject || !notifyBody) {
      throw new BadRequestException('Indiquez l’objet et le message à envoyer au parent.');
    }

    const firstName = str(childIn.firstName ?? enrollment.child.firstName, 80);
    const lastName = str(childIn.lastName ?? enrollment.child.lastName, 80);
    if (!firstName || !lastName) {
      throw new BadRequestException('Le prénom et le nom de l’enfant sont obligatoires.');
    }

    const gender = parseGenderInput(childIn.gender ?? enrollment.child.gender);
    const birthDate = parseBirthDateInput(
      childIn.birthDate !== undefined ? childIn.birthDate : isoDay(enrollment.child.birthDate),
    );

    const nextLevelId = str(body.levelId ?? childIn.levelId ?? enrollment.levelId, 80);
    if (!nextLevelId) throw new BadRequestException('Le niveau est obligatoire.');
    const level = await this.prisma.level.findUnique({ where: { id: nextLevelId } });
    if (!level) throw new NotFoundException('Niveau introuvable.');

    const nextScheduleId = str(
      body.scheduleId ?? optionsIn.scheduleId ?? enrollment.scheduleId ?? '',
      80,
    );
    let scheduleLabel = str(
      optionsIn.scheduleLabel ?? enrollment.schedule?.label ?? '',
      120,
    );
    if (nextScheduleId) {
      const schedule = await this.prisma.levelSchedule.findFirst({
        where: {
          id: nextScheduleId,
          levelId: nextLevelId,
          schoolYear: enrollment.schoolYear,
        },
      });
      if (!schedule) {
        throw new BadRequestException(
          'La formule horaire ne correspond pas au niveau ou à l’année scolaire.',
        );
      }
      scheduleLabel = schedule.label;
    }

    const wizard = parseWizardData(enrollment.wizardData);
    const extras = wizard.childExtras ?? {};
    const nextExtras = {
      birthPlace: optStr(childIn.birthPlace ?? extras.birthPlace, 120),
      nationality: optStr(childIn.nationality ?? extras.nationality, 80),
      homeLanguages: optStr(childIn.homeLanguages ?? extras.homeLanguages, 120),
      matricule: optStr(childIn.matricule ?? extras.matricule, 80),
      childAddress: optStr(childIn.childAddress ?? extras.childAddress, 200),
      previousSchool: optStr(childIn.previousSchool ?? extras.previousSchool, 200),
      levelName: level.name,
    };

    const parentFullName = str(
      parentIn.fullName ??
        enrollment.child.parent?.fullName ??
        `${enrollment.pendingParentFirstName ?? ''} ${enrollment.pendingParentLastName ?? ''}`,
      120,
    );
    const parentRelation = parseParentRelationInput(
      parentIn.relation ?? enrollment.pendingParentRelation ?? enrollment.child.parent?.parentRelation,
    );
    const parentPhone = optStr(
      parentIn.phone ?? enrollment.child.parent?.phone ?? enrollment.pendingParentPhone,
      40,
    );
    const parentAddress = optStr(
      parentIn.address ?? enrollment.child.parent?.address ?? enrollment.pendingParentAddress,
      200,
    );
    const parentProfession = optStr(
      parentIn.profession ?? wizard.parentExtras?.profession,
      120,
    );
    const pendingNames = splitFullName(parentFullName);

    const g2Src = guardian2In ?? wizard.guardian2 ?? {};
    const guardian2 = {
      fullName: str((g2Src as Record<string, unknown>).fullName, 120),
      relation: str((g2Src as Record<string, unknown>).relation, 80),
      phone: str((g2Src as Record<string, unknown>).phone, 40),
      email: str((g2Src as Record<string, unknown>).email, 120),
    };

    const emSrc = emergencyIn ?? wizard.emergency ?? {};
    const emergency = {
      source: optStr((emSrc as Record<string, unknown>).source, 40),
      fullName: str((emSrc as Record<string, unknown>).fullName, 120),
      relation: str((emSrc as Record<string, unknown>).relation, 80),
      phone: str((emSrc as Record<string, unknown>).phone, 40),
    };

    const authIn = asObj(optionsIn.authorizations) ?? {};
    const prevAuth = wizard.options?.authorizations;
    const authorizations = {
      photosInternal: asBool(
        (authIn as Record<string, unknown>).photosInternal ?? prevAuth?.photosInternal ?? true,
      ),
      photosCommunication: asBool(
        (authIn as Record<string, unknown>).photosCommunication ??
          prevAuth?.photosCommunication ??
          false,
      ),
      outings: asBool((authIn as Record<string, unknown>).outings ?? prevAuth?.outings ?? true),
      firstAid: asBool((authIn as Record<string, unknown>).firstAid ?? prevAuth?.firstAid ?? true),
    };
    const comment = optStr(optionsIn.comment ?? wizard.options?.comment, 2000);

    const rawSelections = Array.isArray(optionsIn.serviceSelections)
      ? optionsIn.serviceSelections
      : Array.isArray(body.serviceSelections)
        ? body.serviceSelections
        : null;
    const currentSelections = enrollment.serviceSubscriptions.map((s) => ({
      serviceTariffId: s.serviceTariffId,
      code: s.serviceTariff.code,
      variantId: s.variantId,
    }));
    let nextSelections = currentSelections;
    if (rawSelections) {
      nextSelections = (rawSelections as unknown[])
        .map((row) => {
          const r = asObj(row);
          if (!r) return null;
          const serviceTariffId = str(r.serviceTariffId, 80);
          if (!serviceTariffId) return null;
          const variantRaw = r.variantId;
          const variantId =
            variantRaw === undefined || variantRaw === null || variantRaw === ''
              ? null
              : str(variantRaw, 80);
          return {
            serviceTariffId,
            code: str(r.code, 40).toUpperCase(),
            variantId,
          };
        })
        .filter(Boolean) as Array<{ serviceTariffId: string; code: string; variantId: string | null }>;
    }

    const healthRecord = enrollment.child.healthRecord;
    const nextHealthRaw = {
      bloodGroup: healthIn?.bloodGroup ?? healthRecord?.bloodGroup,
      doctorName: healthIn?.doctorName ?? healthRecord?.doctorName,
      doctorPhone: healthIn?.doctorPhone ?? healthRecord?.doctorPhone,
      knownAllergies:
        healthIn?.knownAllergies ?? healthRecord?.knownAllergies ?? enrollment.child.allergies,
      ongoingTreatments: healthIn?.ongoingTreatments ?? healthRecord?.ongoingTreatments,
      dietaryRegime: healthIn?.dietaryRegime ?? healthRecord?.dietaryRegime,
      instructions: healthIn?.instructions ?? healthRecord?.instructions,
      vaccinations: Array.isArray(healthIn?.vaccinations)
        ? healthIn.vaccinations
        : (healthRecord?.vaccinations ?? []).map((v) => ({
            name: v.name,
            status: v.status,
            vaccinatedAt: v.vaccinatedAt ? isoDay(v.vaccinatedAt) : null,
          })),
    };
    const nextHealth = parsePublicHealthInput(nextHealthRaw);

    const changeLines = this.collectDossierChangeLines({
      enrollment,
      wizard,
      firstName,
      lastName,
      gender,
      birthDate,
      levelName: level.name,
      extras: nextExtras,
      scheduleLabel: nextScheduleId ? scheduleLabel : '',
      parentFullName,
      parentRelation,
      parentPhone: parentPhone ?? '',
      parentAddress: parentAddress ?? '',
      parentProfession: parentProfession ?? '',
      guardian2,
      emergency,
      authorizations,
      comment: comment ?? '',
      nextSelections,
      nextHealth,
    });
    if (changeLines.length === 0) {
      throw new BadRequestException('Aucune modification à enregistrer.');
    }

    const nextWizard: EnrollmentWizardData = {
      ...wizard,
      childExtras: nextExtras,
      parentExtras: parentProfession ? { profession: parentProfession } : undefined,
      guardian2:
        guardian2.fullName || guardian2.phone || guardian2.email
          ? guardian2
          : undefined,
      emergency:
        emergency.fullName || emergency.phone
          ? emergency
          : undefined,
      options: {
        ...(wizard.options ?? {}),
        scheduleId: nextScheduleId || undefined,
        scheduleLabel: nextScheduleId ? scheduleLabel : undefined,
        authorizations,
        comment,
        services: nextSelections.map((s) => s.code).filter(Boolean),
        serviceSelections: nextSelections,
      },
    };

    const levelChanged = nextLevelId !== enrollment.levelId;

    await this.prisma.$transaction(async (tx) => {
      await tx.child.update({
        where: { id: enrollment.childId },
        data: {
          firstName,
          lastName,
          gender,
          birthDate,
          allergies: nextHealth.knownAllergies,
        },
      });

      if (enrollment.child.parentId) {
        await tx.user.update({
          where: { id: enrollment.child.parentId },
          data: {
            fullName: parentFullName || null,
            phone: parentPhone ?? null,
            address: parentAddress ?? null,
            parentRelation,
          },
        });
      }

      await tx.enrollment.update({
        where: { id },
        data: {
          levelId: nextLevelId,
          scheduleId: nextScheduleId || null,
          classId: levelChanged ? null : enrollment.classId,
          pendingParentFirstName: pendingNames.first || null,
          pendingParentLastName: pendingNames.last || null,
          pendingParentPhone: parentPhone ?? null,
          pendingParentAddress: parentAddress ?? null,
          pendingParentRelation: parentRelation,
          wizardData: JSON.parse(JSON.stringify(nextWizard)) as Prisma.InputJsonValue,
        },
      });

      await upsertChildHealthRecordInTx(tx, enrollment.childId, nextHealth);
      await this.billing.replaceServiceSubscriptions(tx, id, nextSelections);
    });

    const childLine = `${firstName} ${lastName}`.trim();
    const parentName =
      parentFullName ||
      enrollment.child.parent?.fullName ||
      [enrollment.pendingParentFirstName, enrollment.pendingParentLastName].filter(Boolean).join(' ') ||
      null;
    const parentPhoneForMail =
      parentPhone || enrollment.child.parent?.phone || enrollment.pendingParentPhone || null;
    const defaultTo =
      enrollment.child.parent?.email?.trim() || enrollment.pendingParentEmail?.trim() || '';
    const notifyToRaw = str(notifyIn.to ?? notifyIn.email, 120).toLowerCase();
    if (notifyToRaw && !looksLikeEmail(notifyToRaw)) {
      throw new BadRequestException('L’adresse e-mail de notification est invalide.');
    }
    const notifyTo = notifyToRaw || defaultTo.toLowerCase();

    const parentId = enrollment.child.parentId;
    if (parentId) {
      await this.notifications
        .notifyEnrollmentDossierUpdated({
          parentId,
          enrollmentId: id,
          childName: childLine,
          body: notifyBody,
        })
        .catch((err) => {
          this.logger.warn(
            `Notification in-app dossier ${id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }

    let emailSent = false;
    if (notifyTo) {
      emailSent = await this.mail.sendEnrollmentDossierUpdated({
        to: notifyTo,
        parentName,
        parentPhone: parentPhoneForMail,
        schoolYear: enrollment.schoolYear,
        childLine: `${childLine} — ${level.name}`,
        subject: notifySubject,
        body: notifyBody,
      });
    }

    const [stats, updated] = await Promise.all([
      this.getStats(),
      this.enrollmentsCore.getOne(id),
    ]);
    return {
      stats,
      enrollment: updated,
      notified: Boolean(parentId) || emailSent,
      emailSent,
      recipient: notifyTo || null,
    };
  }

  private collectDossierChangeLines(input: {
    enrollment: {
      child: {
        firstName: string;
        lastName: string;
        gender: Gender;
        birthDate: Date | null;
        allergies: string | null;
        parent: {
          fullName: string | null;
          phone: string | null;
          address: string | null;
          parentRelation: ParentRelation | null;
        } | null;
        healthRecord: {
          bloodGroup: string | null;
          doctorName: string | null;
          doctorPhone: string | null;
          knownAllergies: string | null;
          ongoingTreatments: string | null;
          dietaryRegime: string | null;
          instructions: string | null;
          vaccinations: Array<{ name: string; status: string; vaccinatedAt: Date | null }>;
        } | null;
      };
      level: { name: string };
      schedule: { label: string } | null;
      pendingParentFirstName: string | null;
      pendingParentLastName: string | null;
      pendingParentPhone: string | null;
      pendingParentAddress: string | null;
      pendingParentRelation: ParentRelation | null;
      serviceSubscriptions: Array<{
        serviceTariffId: string;
        variantId: string | null;
        serviceTariff: { label: string; code: string };
        variant: { label: string } | null;
      }>;
    };
    wizard: EnrollmentWizardData;
    firstName: string;
    lastName: string;
    gender: Gender;
    birthDate: Date | null;
    levelName: string;
    extras: {
      birthPlace?: string;
      nationality?: string;
      homeLanguages?: string;
      matricule?: string;
      childAddress?: string;
      previousSchool?: string;
    };
    scheduleLabel: string;
    parentFullName: string;
    parentRelation: ParentRelation | null;
    parentPhone: string;
    parentAddress: string;
    parentProfession: string;
    guardian2: { fullName: string; relation: string; phone: string; email: string };
    emergency: { fullName: string; relation: string; phone: string };
    authorizations: {
      photosInternal: boolean;
      photosCommunication: boolean;
      outings: boolean;
      firstAid: boolean;
    };
    comment: string;
    nextSelections: Array<{ serviceTariffId: string; variantId: string | null }>;
    nextHealth: ReturnType<typeof parsePublicHealthInput>;
  }): string[] {
    const lines: string[] = [];
    const add = (label: string, before: string, after: string) => {
      const a = before.trim();
      const b = after.trim();
      if (a === b) return;
      lines.push(`${label} : ${a || '—'} → ${b || '—'}`);
    };

    const e = input.enrollment;
    const extras = input.wizard.childExtras ?? {};
    add('Prénom', e.child.firstName, input.firstName);
    add('Nom', e.child.lastName, input.lastName);
    add('Date de naissance', isoDay(e.child.birthDate), isoDay(input.birthDate));
    add('Genre', genderLabelFr(e.child.gender), genderLabelFr(input.gender));
    add('Lieu de naissance', extras.birthPlace ?? '', input.extras.birthPlace ?? '');
    add('Nationalité', extras.nationality ?? '', input.extras.nationality ?? '');
    add('Langue(s) à la maison', extras.homeLanguages ?? '', input.extras.homeLanguages ?? '');
    add('Matricule', extras.matricule ?? '', input.extras.matricule ?? '');
    add('Adresse de l’enfant', extras.childAddress ?? '', input.extras.childAddress ?? '');
    add('École précédente', extras.previousSchool ?? '', input.extras.previousSchool ?? '');
    add('Classe demandée', e.level.name, input.levelName);
    add(
      'Formule horaire',
      e.schedule?.label || input.wizard.options?.scheduleLabel || '',
      input.scheduleLabel,
    );

    const oldParentName =
      e.child.parent?.fullName?.trim() ||
      `${e.pendingParentFirstName ?? ''} ${e.pendingParentLastName ?? ''}`.trim();
    add('Parent inscripteur', oldParentName, input.parentFullName);
    add(
      'Lien avec l’enfant',
      relationLabelFr(e.pendingParentRelation ?? e.child.parent?.parentRelation),
      relationLabelFr(input.parentRelation),
    );
    add(
      'Téléphone parent',
      e.child.parent?.phone ?? e.pendingParentPhone ?? '',
      input.parentPhone,
    );
    add(
      'Adresse parent',
      e.child.parent?.address ?? e.pendingParentAddress ?? '',
      input.parentAddress,
    );
    add('Profession', input.wizard.parentExtras?.profession ?? '', input.parentProfession);

    const g2 = input.wizard.guardian2 ?? {};
    add(
      'Parent / responsable 2',
      [g2.fullName, g2.relation, g2.phone, g2.email].filter(Boolean).join(' · '),
      [input.guardian2.fullName, input.guardian2.relation, input.guardian2.phone, input.guardian2.email]
        .filter(Boolean)
        .join(' · '),
    );
    const em = input.wizard.emergency ?? {};
    add(
      'Contact d’urgence',
      [em.fullName, em.relation, em.phone].filter(Boolean).join(' · '),
      [input.emergency.fullName, input.emergency.relation, input.emergency.phone]
        .filter(Boolean)
        .join(' · '),
    );

    const h = e.child.healthRecord;
    add('Médecin référent', h?.doctorName ?? '', input.nextHealth.doctorName ?? '');
    add('Téléphone du cabinet', h?.doctorPhone ?? '', input.nextHealth.doctorPhone ?? '');
    add('Groupe sanguin', h?.bloodGroup ?? '', input.nextHealth.bloodGroup ?? '');
    add(
      'Allergies',
      h?.knownAllergies ?? e.child.allergies ?? '',
      input.nextHealth.knownAllergies ?? '',
    );
    add('Traitements', h?.ongoingTreatments ?? '', input.nextHealth.ongoingTreatments ?? '');
    add('Régime alimentaire', h?.dietaryRegime ?? '', input.nextHealth.dietaryRegime ?? '');
    add('Consigne équipe', h?.instructions ?? '', input.nextHealth.instructions ?? '');

    const vaxKey = (list: Array<{ name: string; status: string; vaccinatedAt?: Date | string | null }>) =>
      list
        .map((v) => `${v.name}|${v.status}|${isoDay(v.vaccinatedAt ? new Date(v.vaccinatedAt) : null)}`)
        .sort()
        .join(';');
    if (vaxKey(h?.vaccinations ?? []) !== vaxKey(input.nextHealth.vaccinations)) {
      lines.push('Vaccinations mises à jour');
    }

    const auth = input.wizard.options?.authorizations;
    add(
      'Autorisation photos internes',
      yn(auth?.photosInternal ?? true),
      yn(input.authorizations.photosInternal),
    );
    add(
      'Autorisation photos communication',
      yn(auth?.photosCommunication ?? false),
      yn(input.authorizations.photosCommunication),
    );
    add('Autorisation sorties', yn(auth?.outings ?? true), yn(input.authorizations.outings));
    add(
      'Autorisation premiers secours',
      yn(auth?.firstAid ?? true),
      yn(input.authorizations.firstAid),
    );
    add('Commentaire', input.wizard.options?.comment ?? '', input.comment);

    const oldSvc = e.serviceSubscriptions
      .map((s) => `${s.serviceTariffId}:${s.variantId ?? ''}`)
      .sort()
      .join('|');
    const newSvc = input.nextSelections
      .map((s) => `${s.serviceTariffId}:${s.variantId ?? ''}`)
      .sort()
      .join('|');
    if (oldSvc !== newSvc) {
      const labels = e.serviceSubscriptions
        .map((s) => (s.variant?.label ? `${s.serviceTariff.label} — ${s.variant.label}` : s.serviceTariff.label))
        .join(', ');
      lines.push(`Services : ${labels || 'aucun'} → sélection mise à jour`);
    }

    return lines.map((line) => stripTechnicalIds(line));
  }
}
