import 'dotenv/config';
import { PrismaClient, UserRole, AppModuleRole } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcrypt';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Missing DATABASE_URL in backend-commonwealth/.env');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg(databaseUrl),
});

async function main() {
  // Maternelle: Petite Section, Moyenne Section, Grande Section
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
  console.log(`Seed admin: ${adminEmail} (mot de passe: variable ADMIN_PASSWORD ou défaut pour le dev)`);
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

