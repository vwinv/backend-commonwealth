import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AppModuleRole, Prisma, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { AdminPermissionsService } from '../auth/admin-permissions.service';
import {
  ALL_APP_MODULE_ROLES,
  APP_MODULE_ROLE_LABELS,
  isSuperAdmin,
  parseAppModuleRole,
  roleOptionsForApi,
} from '../auth/app-module-roles';

function showTempPasswordOnUserCreate(config: ConfigService): boolean {
  return config.get<string>('SHOW_TEMP_PASSWORD_ON_USER_CREATE')?.trim().toLowerCase() === 'true';
}

function buildCredentialMessage(
  config: ConfigService,
  opts: {
    email: string;
    fullName: string;
    emailSent: boolean;
    temporaryPassword: string;
    kind: 'create' | 'reset';
  },
) {
  const showTemp = showTempPasswordOnUserCreate(config);
  const name = opts.fullName;
  let message: string;
  if (opts.kind === 'reset') {
    message = opts.emailSent
      ? `Mot de passe réinitialisé. Un e-mail a été envoyé à ${opts.email}.`
      : showTemp
        ? `Mot de passe réinitialisé pour ${name}.`
        : `Mot de passe réinitialisé pour ${name}. L’e-mail n’a pas pu être envoyé — vérifiez la configuration SMTP.`;
  } else {
    message = opts.emailSent
      ? `Compte créé. Un e-mail avec les identifiants a été envoyé à ${opts.email}.`
      : showTemp
        ? `Compte créé. Mot de passe temporaire affiché ci-dessous (mode développement).`
        : `Compte créé. L’e-mail d’accès n’a pas pu être envoyé — vérifiez la configuration SMTP.`;
  }
  return {
    message,
    temporaryPassword: showTemp ? opts.temporaryPassword : undefined,
    emailSent: opts.emailSent,
  };
}

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adminPermissions: AdminPermissionsService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  listRoleOptions() {
    return { items: roleOptionsForApi() };
  }

  private staffWhere(search?: string): Prisma.UserWhereInput {
    const base: Prisma.UserWhereInput = {
      role: { in: [UserRole.ADMIN, UserRole.STAFF] },
    };
    const q = search?.trim();
    if (!q) return base;
    return {
      ...base,
      OR: [
        { fullName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { jobTitle: { contains: q, mode: 'insensitive' } },
      ],
    };
  }

  private mapAppRoles(roles: { role: AppModuleRole }[]) {
    return roles.map((r) => ({
      code: r.role,
      label: APP_MODULE_ROLE_LABELS[r.role],
    }));
  }

  async getOverview(query: {
    page?: number;
    limit?: number;
    search?: string;
    sort?: string;
  }) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 8));
    const skip = (page - 1) * limit;
    const where = this.staffWhere(query.search);

    let orderBy: Prisma.UserOrderByWithRelationInput | Prisma.UserOrderByWithRelationInput[] = {
      createdAt: 'desc',
    };
    const sort = query.sort?.trim();
    if (sort === 'date_asc') {
      orderBy = { createdAt: 'asc' };
    } else if (sort === 'name_asc') {
      orderBy = { fullName: 'asc' };
    } else if (sort === 'name_desc') {
      orderBy = { fullName: 'desc' };
    }

    const staffBase: Prisma.UserWhereInput = {
      role: { in: [UserRole.ADMIN, UserRole.STAFF] },
    };

    const [total, active, blocked, administrators, listTotal, rows] = await Promise.all([
      this.prisma.user.count({ where: staffBase }),
      this.prisma.user.count({ where: { ...staffBase, blocked: false } }),
      this.prisma.user.count({ where: { ...staffBase, blocked: true } }),
      this.prisma.user.count({ where: { role: UserRole.ADMIN } }),
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        select: {
          id: true,
          email: true,
          fullName: true,
          jobTitle: true,
          role: true,
          blocked: true,
          createdAt: true,
          appModuleRoles: { select: { role: true } },
        },
      }),
    ]);

    return {
      stats: {
        total,
        active,
        blocked,
        administrators,
      },
      items: rows.map((u) => ({
        id: u.id,
        fullName: u.fullName?.trim() || u.email,
        email: u.email,
        jobTitle: u.jobTitle?.trim() || null,
        isSuperAdmin: isSuperAdmin(u.role),
        appRoles: isSuperAdmin(u.role)
          ? ALL_APP_MODULE_ROLES.map((code) => ({
              code,
              label: APP_MODULE_ROLE_LABELS[code],
            }))
          : this.mapAppRoles(u.appModuleRoles),
        blocked: u.blocked,
        active: !u.blocked,
      })),
      total: listTotal,
      page,
      limit,
      roleOptions: roleOptionsForApi(),
    };
  }

  async create(actorRole: UserRole, body: Record<string, unknown>) {
    if (!isSuperAdmin(actorRole)) {
      throw new ForbiddenException('Seul un super administrateur peut créer un utilisateur.');
    }

    const email = String(body?.email ?? '').trim().toLowerCase();
    const fullName = String(body?.fullName ?? '').trim();
    const jobTitle = String(body?.jobTitle ?? '').trim();
    const blocked = body?.active === false || body?.blocked === true;
    const accessLevel = String(body?.accessLevel ?? 'STAFF').trim().toUpperCase();
    const systemRole =
      accessLevel === 'ADMIN' || accessLevel === UserRole.ADMIN
        ? UserRole.ADMIN
        : UserRole.STAFF;

    if (!email) throw new BadRequestException('L’adresse e-mail est obligatoire.');
    if (!fullName) throw new BadRequestException('Le nom complet est obligatoire.');
    if (!jobTitle) throw new BadRequestException('Le poste est obligatoire.');

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new BadRequestException('Un compte existe déjà avec cette adresse e-mail.');
    }

    const temporaryPassword = randomBytes(9).toString('base64url').slice(0, 12);
    const passwordHash = await bcrypt.hash(temporaryPassword, 10);

    let appRoles: AppModuleRole[] = [];
    if (systemRole === UserRole.STAFF && body?.appRoleCodes !== undefined) {
      const raw = body.appRoleCodes;
      if (!Array.isArray(raw)) {
        throw new BadRequestException('appRoleCodes doit être un tableau.');
      }
      for (const item of raw) {
        const role = parseAppModuleRole(item);
        if (!role) throw new BadRequestException(`Rôle invalide : ${String(item)}`);
        appRoles.push(role);
      }
    }

    try {
      const created = await this.prisma.user.create({
        data: {
          email,
          fullName,
          jobTitle,
          role: systemRole,
          blocked,
          passwordHash,
          mustChangePassword: true,
        },
        select: {
          id: true,
          email: true,
          fullName: true,
          jobTitle: true,
          role: true,
          blocked: true,
        },
      });

      if (systemRole === UserRole.STAFF && appRoles.length > 0) {
        await this.adminPermissions.syncUserModuleRoles(created.id, appRoles);
      }

      const emailSent = await this.mail.sendStaffPortalCredentials({
        to: email,
        fullName,
        password: temporaryPassword,
        jobTitle,
      });

      const feedback = buildCredentialMessage(this.config, {
        email,
        fullName: created.fullName?.trim() || email,
        emailSent,
        temporaryPassword,
        kind: 'create',
      });

      return {
        user: {
          id: created.id,
          fullName: created.fullName?.trim() || created.email,
          email: created.email,
          jobTitle: created.jobTitle?.trim() || null,
          isSuperAdmin: isSuperAdmin(created.role),
          blocked: created.blocked,
          active: !created.blocked,
        },
        ...feedback,
      };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Un compte existe déjà avec cette adresse e-mail.');
      }
      throw e;
    }
  }

  async resetPassword(actorId: string, actorRole: UserRole, userId: string) {
    if (!isSuperAdmin(actorRole)) {
      throw new ForbiddenException('Seul un super administrateur peut réinitialiser un mot de passe.');
    }
    if (userId === actorId) {
      throw new BadRequestException(
        'Pour votre propre compte, utilisez la page de changement de mot de passe.',
      );
    }

    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        role: { in: [UserRole.ADMIN, UserRole.STAFF] },
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        jobTitle: true,
        blocked: true,
      },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    if (user.blocked) {
      throw new BadRequestException('Impossible de réinitialiser le mot de passe d’un compte bloqué.');
    }

    const temporaryPassword = randomBytes(9).toString('base64url').slice(0, 12);
    const passwordHash = await bcrypt.hash(temporaryPassword, 10);

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: true },
    });

    const emailSent = await this.mail.sendStaffPortalCredentials({
      to: user.email,
      fullName: user.fullName,
      password: temporaryPassword,
      jobTitle: user.jobTitle,
      isPasswordReset: true,
    });

    const feedback = buildCredentialMessage(this.config, {
      email: user.email,
      fullName: user.fullName?.trim() || user.email,
      emailSent,
      temporaryPassword,
      kind: 'reset',
    });

    return {
      user: {
        id: user.id,
        fullName: user.fullName?.trim() || user.email,
        email: user.email,
      },
      ...feedback,
    };
  }

  async update(actorId: string, actorRole: UserRole, userId: string, body: Record<string, unknown>) {
    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        role: { in: [UserRole.ADMIN, UserRole.STAFF] },
      },
      include: { appModuleRoles: { select: { role: true } } },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');

    const data: Prisma.UserUpdateInput = {};
    let rolesUpdated = false;

    if (body.blocked !== undefined) {
      const blocked = Boolean(body.blocked);
      if (blocked && userId === actorId) {
        throw new BadRequestException('Vous ne pouvez pas bloquer votre propre compte.');
      }
      data.blocked = blocked;
    }

    if (body.jobTitle !== undefined) {
      const jobTitle = String(body.jobTitle ?? '').trim();
      data.jobTitle = jobTitle || null;
    }

    if (body.appRoleCodes !== undefined) {
      if (!isSuperAdmin(actorRole)) {
        throw new ForbiddenException('Seul un super administrateur peut modifier les rôles d’accès.');
      }
      if (isSuperAdmin(user.role)) {
        throw new BadRequestException('Les rôles d’un super administrateur ne sont pas modifiables.');
      }
      const raw = body.appRoleCodes;
      if (!Array.isArray(raw)) {
        throw new BadRequestException('appRoleCodes doit être un tableau.');
      }
      const parsed: AppModuleRole[] = [];
      for (const item of raw) {
        const role = parseAppModuleRole(item);
        if (!role) throw new BadRequestException(`Rôle invalide : ${String(item)}`);
        parsed.push(role);
      }
      await this.adminPermissions.syncUserModuleRoles(userId, parsed);
      rolesUpdated = true;
    }

    if (Object.keys(data).length === 0 && !rolesUpdated) {
      throw new BadRequestException('Corps de requête invalide.');
    }

    const updated =
      Object.keys(data).length > 0
        ? await this.prisma.user.update({
            where: { id: userId },
            data,
            select: {
              id: true,
              email: true,
              fullName: true,
              jobTitle: true,
              role: true,
              blocked: true,
              appModuleRoles: { select: { role: true } },
            },
          })
        : await this.prisma.user.findUniqueOrThrow({
            where: { id: userId },
            select: {
              id: true,
              email: true,
              fullName: true,
              jobTitle: true,
              role: true,
              blocked: true,
              appModuleRoles: { select: { role: true } },
            },
          });

    return {
      id: updated.id,
      fullName: updated.fullName?.trim() || updated.email,
      email: updated.email,
      jobTitle: updated.jobTitle?.trim() || null,
      isSuperAdmin: isSuperAdmin(updated.role),
      appRoles: isSuperAdmin(updated.role)
        ? ALL_APP_MODULE_ROLES.map((code) => ({
            code,
            label: APP_MODULE_ROLE_LABELS[code],
          }))
        : this.mapAppRoles(updated.appModuleRoles),
      blocked: updated.blocked,
      active: !updated.blocked,
    };
  }

  async remove(actorId: string, actorRole: UserRole, userId: string) {
    if (!isSuperAdmin(actorRole)) {
      throw new ForbiddenException('Seul un super administrateur peut supprimer un utilisateur.');
    }
    if (userId === actorId) {
      throw new BadRequestException('Vous ne pouvez pas supprimer votre propre compte.');
    }

    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        role: { in: [UserRole.ADMIN, UserRole.STAFF] },
      },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');

    if (user.role === UserRole.ADMIN) {
      const adminCount = await this.prisma.user.count({ where: { role: UserRole.ADMIN } });
      if (adminCount <= 1) {
        throw new BadRequestException('Impossible de supprimer le dernier super administrateur.');
      }
    }

    await this.prisma.user.delete({ where: { id: userId } });
  }
}
