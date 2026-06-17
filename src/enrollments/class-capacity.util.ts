import { BadRequestException } from '@nestjs/common';
import { EnrollmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type DbClient = PrismaService | Prisma.TransactionClient;

export const LEVEL_ENROLLMENT_CLOSED_MESSAGE = 'Les inscriptions sont fermées pour ce niveau.';

export type LevelCapacitySnapshot = {
  totalCapacity: number;
  occupiedCount: number;
  enrollmentOpen: boolean;
  availableSpots: number;
};

export async function getLevelCapacitySnapshot(
  db: DbClient,
  levelId: string,
  schoolYear: string,
  excludeEnrollmentId?: string,
): Promise<LevelCapacitySnapshot> {
  const classes = await db.classRoom.findMany({
    where: { levelId },
    select: { capacity: true },
  });

  if (classes.length === 0) {
    return { totalCapacity: 0, occupiedCount: 0, enrollmentOpen: false, availableSpots: 0 };
  }

  const totalCapacity = classes.reduce((sum, c) => sum + c.capacity, 0);
  const where: Prisma.EnrollmentWhereInput = {
    levelId,
    schoolYear,
    status: { in: [EnrollmentStatus.APPROVED, EnrollmentStatus.PENDING] },
  };
  if (excludeEnrollmentId) {
    where.id = { not: excludeEnrollmentId };
  }

  const occupiedCount = await db.enrollment.count({ where });
  const availableSpots = Math.max(0, totalCapacity - occupiedCount);

  return {
    totalCapacity,
    occupiedCount,
    enrollmentOpen: occupiedCount < totalCapacity,
    availableSpots,
  };
}

export async function assertLevelEnrollmentOpen(
  db: DbClient,
  levelId: string,
  schoolYear: string,
  excludeEnrollmentId?: string,
): Promise<void> {
  const snapshot = await getLevelCapacitySnapshot(db, levelId, schoolYear, excludeEnrollmentId);
  if (!snapshot.enrollmentOpen) {
    throw new BadRequestException(LEVEL_ENROLLMENT_CLOSED_MESSAGE);
  }
}

/** Première classe non pleine, par ordre de création. */
export async function findNextAvailableClassId(
  db: DbClient,
  levelId: string,
  schoolYear: string,
): Promise<string | null> {
  const classes = await db.classRoom.findMany({
    where: { levelId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, capacity: true },
  });

  for (const classroom of classes) {
    const count = await db.enrollment.count({
      where: {
        classId: classroom.id,
        schoolYear,
        status: EnrollmentStatus.APPROVED,
      },
    });
    if (count < classroom.capacity) {
      return classroom.id;
    }
  }

  return null;
}

export async function resolveClassIdForApproval(
  db: DbClient,
  levelId: string,
  schoolYear: string,
  classId?: string,
): Promise<string> {
  if (classId) {
    const classroom = await db.classRoom.findFirst({
      where: { id: classId, levelId },
      select: { id: true, capacity: true },
    });
    if (!classroom) {
      throw new BadRequestException('Classe introuvable pour ce niveau.');
    }
    const count = await db.enrollment.count({
      where: {
        classId: classroom.id,
        schoolYear,
        status: EnrollmentStatus.APPROVED,
      },
    });
    if (count >= classroom.capacity) {
      throw new BadRequestException('Cette classe est complète.');
    }
    return classroom.id;
  }

  const nextClassId = await findNextAvailableClassId(db, levelId, schoolYear);
  if (!nextClassId) {
    throw new BadRequestException(
      'Aucune place disponible : toutes les classes de ce niveau sont complètes.',
    );
  }
  return nextClassId;
}
