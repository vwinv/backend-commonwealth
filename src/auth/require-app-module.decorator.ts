import { SetMetadata } from '@nestjs/common';
import type { AppModuleRole } from '@prisma/client';

export const REQUIRE_APP_MODULE_KEY = 'requireAppModule';

/** Module(s) requis pour l'endpoint. Absent = pas de contrôle module (le Home a son propre garde). */
export const RequireAppModule = (...modules: AppModuleRole[]) =>
  SetMetadata(REQUIRE_APP_MODULE_KEY, modules);
