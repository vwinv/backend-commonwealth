import type { ConfigService } from '@nestjs/config';

const DEFAULT_SITE = 'https://www.commonwealth-school.com';

/** URL cliquable dans un e-mail : https par défaut, jamais un host nu. */
export function absolutePublicUrl(raw: string | undefined | null, fallback: string): string {
  const value = String(raw ?? '').trim() || fallback;
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value.replace(/^\/+/, '')}`;
}

export function parentPortalLoginUrl(config: ConfigService): string {
  return absolutePublicUrl(
    config.get<string>('PARENT_PORTAL_LOGIN_URL'),
    `${DEFAULT_SITE}/parent/login`,
  );
}

export function adminPortalLoginUrl(config: ConfigService): string {
  return absolutePublicUrl(
    config.get<string>('ADMIN_PORTAL_LOGIN_URL'),
    `${DEFAULT_SITE}/admin/login`,
  );
}

export function inscriptionResumeUrl(config: ConfigService, resumeToken: string): string {
  const explicit = config.get<string>('PUBLIC_INSCRIPTION_URL')?.trim();
  if (explicit) {
    const base = absolutePublicUrl(explicit, `${DEFAULT_SITE}/inscription`).replace(/\/$/, '');
    return `${base}?resume=${encodeURIComponent(resumeToken)}`;
  }
  const site =
    parentPortalLoginUrl(config).replace(/\/parent\/login\/?$/i, '') || DEFAULT_SITE;
  return `${site.replace(/\/$/, '')}/inscription?resume=${encodeURIComponent(resumeToken)}`;
}
