import { PrismaPg } from '@prisma/adapter-pg';
import type { PoolConfig } from 'pg';

function isLocalPostgres(databaseUrl: string): boolean {
  return /localhost|127\.0\.0\.1/.test(databaseUrl);
}

function withRequiredSsl(databaseUrl: string): string {
  if (isLocalPostgres(databaseUrl) || /sslmode=/i.test(databaseUrl)) {
    return databaseUrl;
  }
  return databaseUrl.includes('?') ? `${databaseUrl}&sslmode=require` : `${databaseUrl}?sslmode=require`;
}

/** Render (et la plupart des Postgres hébergés) exigent SSL, y compris pour les transactions. */
export function createPrismaPgAdapter(databaseUrl: string): PrismaPg {
  const connectionString = withRequiredSsl(databaseUrl);
  const config: PoolConfig = { connectionString };
  if (!isLocalPostgres(connectionString)) {
    config.ssl = { rejectUnauthorized: false };
  }
  return new PrismaPg(config);
}
