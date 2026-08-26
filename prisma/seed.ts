import 'dotenv/config';
import {
  EnrollmentStatus,
  Gender,
  ParentRelation,
  PaymentStatus,
  PrismaClient,
  SchoolYearStatus,
  TuitionBillingLineKind,
  UserRole,
  AppModuleRole,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createPrismaPgAdapter } from '../src/prisma/prisma-pg.adapter';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Missing DATABASE_URL in backend-commonwealth/.env');
}

const prisma = new PrismaClient({
  adapter: createPrismaPgAdapter(databaseUrl),
});

type SeedTarget = 'default' | 'catalog' | 'admin' | 'parent' | 'all';

function parseTarget(): SeedTarget {
  const raw = String(process.argv[2] ?? process.env.SEED ?? 'default')
    .trim()
    .toLowerCase();
  if (raw === 'catalog' || raw === 'admin' || raw === 'parent' || raw === 'all' || raw === 'default') {
    return raw;
  }
  if (raw === 'help' || raw === '-h' || raw === '--help') {
    printHelp();
    process.exit(0);
  }
  // eslint-disable-next-line no-console
  console.error(`Seed inconnu : « ${raw} »`);
  printHelp();
  process.exit(1);
}

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`
Seeds (à lancer séparément selon le besoin) :

  npm run seed:catalog   niveaux + classes + options (cantine, bus, garderie)
  npm run seed:admin     compte administrateur
  npm run seed:parent    parent test uniquement (compte + enfant + petite facture)
  npm run seed:all       tout (catalog + admin + parent)

  npm run prisma:seed    défaut Prisma : catalog + admin, SANS parent test
`);
}

async function seedCatalog() {
  const levels = [
    { name: 'Petite Section', order: 1, classes: ['PS A', 'PS B'] },
    { name: 'Moyenne Section', order: 2, classes: ['MS A', 'MS B'] },
    { name: 'Grande Section', order: 3, classes: ['GS A', 'GS B'] },
  ] as const;

  for (const levelSeed of levels) {
    const level = await prisma.level.upsert({
      where: { name: levelSeed.name },
      update: { order: levelSeed.order },
      create: { name: levelSeed.name, order: levelSeed.order },
    });

    await prisma.classRoom.createMany({
      data: levelSeed.classes.map((name) => ({ levelId: level.id, name })),
      skipDuplicates: true,
    });
  }

  const serviceTariffs = [
    { code: 'CANTINE', label: 'Cantine' },
    { code: 'BUS', label: 'Transport scolaire' },
    { code: 'GARDERIE', label: 'Garderie' },
  ] as const;
  for (const st of serviceTariffs) {
    await prisma.serviceTariff.upsert({
      where: { code: st.code },
      update: { label: st.label, active: true },
      create: { code: st.code, label: st.label, active: true },
    });
  }

  // eslint-disable-next-line no-console
  console.log('Seed catalog : niveaux, classes et options de base.');
}

async function seedAdmin() {
  const adminEmail = (process.env.ADMIN_EMAIL ?? 'admin@commonwealth.com').trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'admin1234';
  const adminHash = await bcrypt.hash(adminPassword, 10);

  const adminUser = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      role: UserRole.ADMIN,
      passwordHash: adminHash,
      fullName: 'Administrateur',
      jobTitle: 'Directeur',
      mustChangePassword: false,
    },
    create: {
      email: adminEmail,
      role: UserRole.ADMIN,
      passwordHash: adminHash,
      fullName: 'Administrateur',
      jobTitle: 'Directeur',
      mustChangePassword: false,
    },
  });

  for (const role of [
    AppModuleRole.INSCRIPTIONS,
    AppModuleRole.ELEVES,
    AppModuleRole.PARENTS,
    AppModuleRole.PROGRAMME,
    AppModuleRole.ATELIERS,
    AppModuleRole.LANDING,
    AppModuleRole.UTILISATEURS,
    AppModuleRole.FINANCE,
    AppModuleRole.DOCUMENTS,
    AppModuleRole.PARAMETRAGE,
  ]) {
    await prisma.userAppModuleRole.upsert({
      where: {
        userId_role: { userId: adminUser.id, role },
      },
      update: {},
      create: { userId: adminUser.id, role },
    });
  }

  // eslint-disable-next-line no-console
  console.log(`Seed admin : ${adminEmail} (mot de passe : ADMIN_PASSWORD ou défaut dev)`);
}

function currentSchoolYearLabel(d = new Date()): string {
  const y = d.getFullYear();
  const start = d.getMonth() + 1 >= 9 ? y : y - 1;
  return `${start}-${start + 1}`;
}

async function seedTestParent() {
  const parentEmail = (process.env.PARENT_TEST_EMAIL ?? 'parent.test@commonwealth.com').trim().toLowerCase();
  const parentPassword = process.env.PARENT_TEST_PASSWORD ?? 'parent1234';
  const parentHash = await bcrypt.hash(parentPassword, 10);

  const existing = await prisma.user.findUnique({ where: { email: parentEmail } });
  if (existing && existing.role !== UserRole.PARENT) {
    throw new Error(`Impossible de créer le parent test : ${parentEmail} existe déjà avec le rôle ${existing.role}.`);
  }

  const parent = await prisma.user.upsert({
    where: { email: parentEmail },
    update: {
      role: UserRole.PARENT,
      passwordHash: parentHash,
      fullName: 'Aminata Test',
      phone: '+2250700000001',
      parentRelation: ParentRelation.MOTHER,
      address: 'Riviera 6, Cocody, Abidjan',
      blocked: false,
      mustChangePassword: false,
      monthlyPaymentPlanEnabled: false,
    },
    create: {
      email: parentEmail,
      role: UserRole.PARENT,
      passwordHash: parentHash,
      fullName: 'Aminata Test',
      phone: '+2250700000001',
      parentRelation: ParentRelation.MOTHER,
      address: 'Riviera 6, Cocody, Abidjan',
      blocked: false,
      mustChangePassword: false,
      monthlyPaymentPlanEnabled: false,
    },
  });

  const schoolYear = currentSchoolYearLabel();
  const startYear = Number(schoolYear.slice(0, 4));
  const openYear = await prisma.schoolYear.findFirst({
    where: { status: SchoolYearStatus.OPEN },
    orderBy: { startDate: 'desc' },
  });
  const yearLabel = openYear?.label ?? schoolYear;
  if (!openYear) {
    await prisma.schoolYear.create({
      data: {
        label: schoolYear,
        startDate: new Date(Date.UTC(startYear, 8, 1)),
        endDate: new Date(Date.UTC(startYear + 1, 6, 31)),
        status: SchoolYearStatus.OPEN,
      },
    });
  }

  const level = await prisma.level.findFirst({ orderBy: { order: 'asc' } });
  if (!level) {
    throw new Error(
      'Aucun niveau en base. Créez-en un dans Paramétrage, ou lancez d’abord : npm run seed:catalog',
    );
  }
  const classRoom = await prisma.classRoom.findFirst({
    where: { levelId: level.id },
    orderBy: { name: 'asc' },
  });

  let child = await prisma.child.findFirst({
    where: { parentId: parent.id, firstName: 'Awa', lastName: 'Test' },
  });
  if (!child) {
    child = await prisma.child.create({
      data: {
        parentId: parent.id,
        firstName: 'Awa',
        lastName: 'Test',
        gender: Gender.FEMALE,
        birthDate: new Date(Date.UTC(startYear - 4, 2, 12)),
      },
    });
  }

  let enrollment = await prisma.enrollment.findFirst({
    where: { childId: child.id, schoolYear: yearLabel },
  });
  if (!enrollment) {
    enrollment = await prisma.enrollment.create({
      data: {
        childId: child.id,
        levelId: level.id,
        classId: classRoom?.id ?? null,
        schoolYear: yearLabel,
        status: EnrollmentStatus.APPROVED,
        wizardStep: 5,
        pendingParentEmail: parentEmail,
        pendingParentFirstName: 'Aminata',
        pendingParentLastName: 'Test',
        pendingParentPhone: '+2250700000001',
        pendingParentRelation: ParentRelation.MOTHER,
        pendingParentAddress: 'Riviera 6, Cocody, Abidjan',
        validatedAt: new Date(),
      },
    });
  } else if (enrollment.status !== EnrollmentStatus.APPROVED) {
    enrollment = await prisma.enrollment.update({
      where: { id: enrollment.id },
      data: { status: EnrollmentStatus.APPROVED, wizardStep: 5, validatedAt: new Date() },
    });
  }

  const tuitionCents = 50_000;
  const existingTuition = await prisma.tuitionCharge.findUnique({
    where: { enrollmentId_schoolYear: { enrollmentId: enrollment.id, schoolYear: yearLabel } },
  });
  if (!existingTuition) {
    await prisma.tuitionCharge.create({
      data: {
        enrollmentId: enrollment.id,
        schoolYear: yearLabel,
        amountCents: tuitionCents,
        status: PaymentStatus.PENDING,
        lines: {
          create: {
            kind: TuitionBillingLineKind.TUITION,
            label: `Scolarité ${yearLabel} (parent test)`,
            quantity: 1,
            unitAmountCents: tuitionCents,
            amountCents: tuitionCents,
            sortOrder: 0,
          },
        },
      },
    });
  } else if (existingTuition.status !== PaymentStatus.PAID && existingTuition.amountCents <= 0) {
    await prisma.tuitionCharge.update({
      where: { id: existingTuition.id },
      data: { amountCents: tuitionCents, status: PaymentStatus.PENDING },
    });
  }

  // eslint-disable-next-line no-console
  console.log(
    `Seed parent test : ${parentEmail} / ${parentPassword} — enfant Awa Test, inscription ${yearLabel} validée, facture 500 XOF`,
  );
}

async function main() {
  const target = parseTarget();
  if (target === 'catalog') {
    await seedCatalog();
    return;
  }
  if (target === 'admin') {
    await seedAdmin();
    return;
  }
  if (target === 'parent') {
    await seedTestParent();
    return;
  }
  if (target === 'all') {
    await seedCatalog();
    await seedAdmin();
    await seedTestParent();
    return;
  }
  await seedCatalog();
  await seedAdmin();
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    await prisma.$disconnect();
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
