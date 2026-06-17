-- Corrige le nom d'index tronqué laissé par la migration supprimée 20260617133610.
-- Sans effet sur une base créée proprement depuis les migrations actuelles.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'ServiceLevelPrice_schoolYear_levelId_serviceTariffId_varian_key'
  ) THEN
    ALTER INDEX "ServiceLevelPrice_schoolYear_levelId_serviceTariffId_varian_key"
      RENAME TO "ServiceLevelPrice_schoolYear_levelId_serviceTariffId_variantId_key";
  END IF;
END $$;
