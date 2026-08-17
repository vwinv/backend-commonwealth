import { AppModuleRole, UserRole } from '@prisma/client';

export const ALL_APP_MODULE_ROLES: AppModuleRole[] = [
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
];

export const APP_MODULE_ROLE_LABELS: Record<AppModuleRole, string> = {
  [AppModuleRole.INSCRIPTIONS]: 'Inscriptions',
  [AppModuleRole.ELEVES]: 'Élèves',
  [AppModuleRole.PARENTS]: 'Parents',
  [AppModuleRole.PROGRAMME]: 'Programme',
  [AppModuleRole.ATELIERS]: 'Gestion des ateliers',
  [AppModuleRole.LANDING]: 'Landing page',
  [AppModuleRole.UTILISATEURS]: 'Utilisateurs',
  [AppModuleRole.FINANCE]: 'Paiements & Comptabilité',
  [AppModuleRole.DOCUMENTS]: 'Documents',
  [AppModuleRole.PARAMETRAGE]: 'Paramétrage',
};

export const DIRECTOR_JOB_TITLE = 'Directeur';

export const ADMIN_PORTAL_ROLES: UserRole[] = [UserRole.ADMIN, UserRole.STAFF];

export function isSuperAdmin(systemRole: UserRole): boolean {
  return systemRole === UserRole.ADMIN;
}

export function isAdminPortalRole(systemRole: UserRole | string | null | undefined): boolean {
  return (
    systemRole === UserRole.ADMIN ||
    systemRole === UserRole.STAFF ||
    systemRole === 'ADMIN' ||
    systemRole === 'STAFF'
  );
}

/** Tableau de bord Home : super admin ou poste Directeur. */
export function canAccessHome(systemRole: UserRole, jobTitle: string | null | undefined): boolean {
  if (isSuperAdmin(systemRole)) return true;
  return String(jobTitle ?? '').trim() === DIRECTOR_JOB_TITLE;
}

export function parseAppModuleRole(raw: unknown): AppModuleRole | null {
  const v = String(raw ?? '').trim().toUpperCase();
  if ((ALL_APP_MODULE_ROLES as string[]).includes(v)) {
    return v as AppModuleRole;
  }
  return null;
}

export function roleOptionsForApi() {
  return ALL_APP_MODULE_ROLES.map((code) => ({
    code,
    label: APP_MODULE_ROLE_LABELS[code],
  }));
}
