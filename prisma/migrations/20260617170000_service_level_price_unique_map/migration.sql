-- Nom d'index court (PostgreSQL tronque les identifiants > 63 caractères).

DROP INDEX IF EXISTS "ServiceLevelPrice_schoolYear_levelId_serviceTariffId_key";
DROP INDEX IF EXISTS "ServiceLevelPrice_schoolYear_levelId_serviceTariffId_varian_key";
DROP INDEX IF EXISTS "ServiceLevelPrice_schoolYear_levelId_serviceTariffId_variantId_key";
DROP INDEX IF EXISTS "ServiceLevelPrice_schoolYear_levelId_serviceTariffId_variantId_";

CREATE UNIQUE INDEX "ServiceLevelPrice_sy_lvl_svc_var_key"
  ON "ServiceLevelPrice"("schoolYear", "levelId", "serviceTariffId", "variantId");
