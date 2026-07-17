import { EnrollmentStatus, Prisma, UserRole } from '@prisma/client';

export type DocumentAudienceRefs = {
  levelIds: string[];
  classIds: string[];
  parentIds: string[];
};

export function isDocumentAudienceGlobal(a: DocumentAudienceRefs): boolean {
  return a.levelIds.length === 0 && a.classIds.length === 0 && a.parentIds.length === 0;
}

/** Parents destinataires : union niveaux ∪ classes ∪ parents nommés ; vide = tous les parents. */
export function documentAudienceParentWhere(a: DocumentAudienceRefs): Prisma.UserWhereInput {
  const base: Prisma.UserWhereInput = {
    role: UserRole.PARENT,
    blocked: false,
  };
  if (isDocumentAudienceGlobal(a)) return base;

  const or: Prisma.UserWhereInput[] = [];
  if (a.parentIds.length > 0) {
    or.push({ id: { in: a.parentIds } });
  }
  if (a.levelIds.length > 0) {
    or.push({
      children: {
        some: {
          enrollments: {
            some: {
              status: EnrollmentStatus.APPROVED,
              levelId: { in: a.levelIds },
            },
          },
        },
      },
    });
  }
  if (a.classIds.length > 0) {
    or.push({
      children: {
        some: {
          enrollments: {
            some: {
              status: EnrollmentStatus.APPROVED,
              classId: { in: a.classIds },
            },
          },
        },
      },
    });
  }
  return { ...base, OR: or };
}

/** Filtre Prisma pour les documents visibles par un parent (niveaux + classes des enfants). */
export function publishedDocumentsForParentWhere(
  parentId: string,
  levelIds: string[],
  classIds: string[],
): Prisma.DocumentWhereInput {
  const audienceOr: Prisma.DocumentWhereInput[] = [
    {
      levels: { none: {} },
      classes: { none: {} },
      targetedParents: { none: {} },
    },
    { targetedParents: { some: { parentId } } },
  ];
  if (levelIds.length > 0) {
    audienceOr.push({ levels: { some: { levelId: { in: levelIds } } } });
  }
  if (classIds.length > 0) {
    audienceOr.push({ classes: { some: { classId: { in: classIds } } } });
  }
  return {
    published: true,
    OR: audienceOr,
  };
}

export function audienceLabelParts(input: {
  levelNames: string[];
  classLabels: string[];
  parentNames: string[];
}): string[] {
  const parts: string[] = [];
  if (input.levelNames.length) parts.push(...input.levelNames);
  if (input.classLabels.length) parts.push(...input.classLabels);
  if (input.parentNames.length) {
    parts.push(
      input.parentNames.length === 1
        ? `Parent : ${input.parentNames[0]}`
        : `${input.parentNames.length} parents ciblés`,
    );
  }
  return parts.length ? parts : ['Tous les niveaux'];
}
