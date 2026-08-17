import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isSuperAdmin } from '../auth/app-module-roles';

export const WIPE_GROUPS = [
  {
    id: 'ateliers',
    label: 'Ateliers',
    hint: 'Les réservations dépendent des ateliers.',
  },
  {
    id: 'eleves',
    label: 'Élèves & suivi',
    hint: 'Santé, vaccins et carnet sont liés à l’élève.',
  },
  {
    id: 'inscriptions',
    label: 'Inscriptions & scolarité',
    hint: 'Paiements et options dépendent de l’inscription (elle-même liée à l’élève).',
  },
  {
    id: 'documents',
    label: 'Documents',
    hint: 'Signatures et liaisons parents / classes / niveaux dépendent du document.',
  },
  {
    id: 'caisse',
    label: 'Caisse',
    hint: 'Dépenses et écritures manuelles dépendent de la session de caisse.',
  },
  {
    id: 'programme',
    label: 'Programme',
    hint: 'Événements et liaisons niveaux dépendent de la catégorie.',
  },
  {
    id: 'catalogue',
    label: 'Niveaux, classes & tarifs',
    hint: 'Classes, horaires et tarifs dépendent des niveaux / années / options.',
  },
  {
    id: 'autres',
    label: 'Notifications, landing & comptes',
    hint: 'Les comptes parents sont liés aux élèves et aux inscriptions.',
  },
] as const;

export const WIPEABLE_TABLES = [
  { key: 'workshopReservation', label: 'Réservations d’ateliers', groupId: 'ateliers' },
  { key: 'workshop', label: 'Ateliers', groupId: 'ateliers' },
  { key: 'childVaccination', label: 'Vaccinations', groupId: 'eleves' },
  { key: 'childHealthRecord', label: 'Fiches santé', groupId: 'eleves' },
  { key: 'childFollowUpNote', label: 'Notes de suivi', groupId: 'eleves' },
  { key: 'child', label: 'Élèves', groupId: 'eleves' },
  { key: 'monthlyInstallmentLine', label: 'Lignes de mensualités', groupId: 'inscriptions' },
  { key: 'monthlyInstallment', label: 'Mensualités', groupId: 'inscriptions' },
  { key: 'tuitionCharge', label: 'Scolarités (charges)', groupId: 'inscriptions' },
  { key: 'monthlyPayment', label: 'Paiements (legacy)', groupId: 'inscriptions' },
  { key: 'enrollmentServiceSubscription', label: 'Options d’inscription', groupId: 'inscriptions' },
  { key: 'enrollment', label: 'Inscriptions', groupId: 'inscriptions' },
  { key: 'documentSignature', label: 'Signatures documents', groupId: 'documents' },
  { key: 'documentParent', label: 'Documents ↔ parents', groupId: 'documents' },
  { key: 'classDocument', label: 'Documents ↔ classes', groupId: 'documents' },
  { key: 'levelDocument', label: 'Documents ↔ niveaux', groupId: 'documents' },
  { key: 'document', label: 'Documents', groupId: 'documents' },
  { key: 'cashExpense', label: 'Dépenses caisse', groupId: 'caisse' },
  { key: 'cashManualEntry', label: 'Écritures caisse manuelles', groupId: 'caisse' },
  { key: 'cashSession', label: 'Sessions de caisse', groupId: 'caisse' },
  { key: 'programEventLevel', label: 'Programme ↔ niveaux', groupId: 'programme' },
  { key: 'programEvent', label: 'Événements programme', groupId: 'programme' },
  { key: 'programmeCategory', label: 'Catégories programme', groupId: 'programme' },
  { key: 'classRoom', label: 'Classes', groupId: 'catalogue' },
  { key: 'serviceLevelPrice', label: 'Tarifs options / niveau', groupId: 'catalogue' },
  { key: 'levelSchoolYearPricing', label: 'Tarifs scolarité / niveau', groupId: 'catalogue' },
  { key: 'levelSchedule', label: 'Horaires des niveaux', groupId: 'catalogue' },
  { key: 'serviceOptionVariant', label: 'Variantes d’options', groupId: 'catalogue' },
  { key: 'serviceTariff', label: 'Options / services', groupId: 'catalogue' },
  { key: 'schoolYear', label: 'Années scolaires', groupId: 'catalogue' },
  { key: 'level', label: 'Niveaux', groupId: 'catalogue' },
  { key: 'notification', label: 'Notifications', groupId: 'autres' },
  { key: 'landingPage', label: 'Contenu landing page', groupId: 'autres' },
  {
    key: 'user',
    label: 'Comptes parents & visiteurs',
    groupId: 'autres',
    hint: 'Les comptes Admin et Staff sont conservés.',
  },
] as const;

export type WipeableTableKey = (typeof WIPEABLE_TABLES)[number]['key'];

const DELETE_ORDER: WipeableTableKey[] = [
  'monthlyInstallmentLine',
  'monthlyInstallment',
  'tuitionCharge',
  'monthlyPayment',
  'enrollmentServiceSubscription',
  'workshopReservation',
  'workshop',
  'childVaccination',
  'childHealthRecord',
  'childFollowUpNote',
  'documentSignature',
  'documentParent',
  'classDocument',
  'levelDocument',
  'cashExpense',
  'cashManualEntry',
  'cashSession',
  'notification',
  'programEventLevel',
  'programEvent',
  'enrollment',
  'child',
  'document',
  'classRoom',
  'serviceLevelPrice',
  'levelSchoolYearPricing',
  'levelSchedule',
  'serviceOptionVariant',
  'serviceTariff',
  'programmeCategory',
  'landingPage',
  'schoolYear',
  'level',
  'user',
];

const ALLOWED = new Set<string>(WIPEABLE_TABLES.map((t) => t.key));

@Injectable()
export class AdminDataService {
  constructor(private readonly prisma: PrismaService) {}

  listTables(actorRole: UserRole) {
    this.assertSuperAdmin(actorRole);
    const groups = WIPE_GROUPS.map((group) => ({
      ...group,
      items: WIPEABLE_TABLES.filter((t) => t.groupId === group.id),
    }));
    return { items: WIPEABLE_TABLES, groups };
  }

  async wipe(actorRole: UserRole, actorId: string, body: Record<string, unknown>) {
    this.assertSuperAdmin(actorRole);

    const confirm = String(body?.confirm ?? '').trim().toUpperCase();
    if (confirm !== 'VIDER') {
      throw new BadRequestException('Confirmez en envoyant confirm: "VIDER".');
    }

    const raw = Array.isArray(body?.tables) ? body.tables : [];
    const selected = [...new Set(raw.map((k) => String(k)))] as WipeableTableKey[];
    if (!selected.length) {
      throw new BadRequestException('Choisissez au moins une table.');
    }
    const unknown = selected.filter((k) => !ALLOWED.has(k));
    if (unknown.length) {
      throw new BadRequestException(`Tables inconnues : ${unknown.join(', ')}`);
    }

    const ordered = DELETE_ORDER.filter((k) => selected.includes(k));
    const results: { key: string; deleted: number }[] = [];

    await this.prisma.$transaction(async (tx) => {
      for (const key of ordered) {
        const deleted = await this.deleteTable(tx, key, actorId);
        results.push({ key, deleted });
      }
    });

    return { ok: true, results };
  }

  private async deleteTable(
    tx: Prisma.TransactionClient,
    key: WipeableTableKey,
    actorId: string,
  ): Promise<number> {
    if (key === 'user') {
      const res = await tx.user.deleteMany({
        where: {
          id: { not: actorId },
          role: { in: [UserRole.PARENT, UserRole.VISITEUR] },
        },
      });
      return res.count;
    }

    const delegate = (tx as unknown as Record<string, { deleteMany: (args?: object) => Promise<{ count: number }> }>)[
      key
    ];
    if (!delegate?.deleteMany) {
      throw new BadRequestException(`Table non gérée : ${key}`);
    }
    const res = await delegate.deleteMany({});
    return res.count;
  }

  private assertSuperAdmin(actorRole: UserRole) {
    if (!isSuperAdmin(actorRole)) {
      throw new ForbiddenException('Réservé à l’administrateur.');
    }
  }
}
