import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

function isLocalPostgres(databaseUrl: string): boolean {
  return /localhost|127\.0\.0\.1/.test(databaseUrl);
}

/** Enlève sslmode/ssl de l’URL pour éviter le conflit avec l’option `ssl` du pool. */
export function stripSslParams(databaseUrl: string): string {
  const [base, query] = databaseUrl.split('?');
  if (!query) return databaseUrl;
  const params = query
    .split('&')
    .filter((part) => part && !/^sslmode=/i.test(part) && !/^ssl=/i.test(part));
  return params.length ? `${base}?${params.join('&')}` : base;
}

/** Render exige SSL mais utilise un certificat non reconnu par Node. */
export function withNoVerifySsl(databaseUrl: string): string {
  if (isLocalPostgres(databaseUrl)) return databaseUrl;
  const cleaned = stripSslParams(databaseUrl);
  return cleaned.includes('?') ? `${cleaned}&sslmode=no-verify` : `${cleaned}?sslmode=no-verify`;
}

export function createPrismaPgAdapter(databaseUrl: string): PrismaPg {
  const local = isLocalPostgres(databaseUrl);
  const pool = new Pool({
    connectionString: stripSslParams(databaseUrl),
    ssl: local ? undefined : { rejectUnauthorized: false },
  });
  return new PrismaPg(pool, { disposeExternalPool: true });
}
