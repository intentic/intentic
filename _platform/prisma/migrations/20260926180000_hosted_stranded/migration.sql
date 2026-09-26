-- A machine the hosted image gate could not put back on its previous version, reported by hosted health.
ALTER TABLE "hosted_machine" ADD COLUMN "strandedAt" TIMESTAMP(3);
ALTER TABLE "hosted_machine" ADD COLUMN "strandedDetail" TEXT;
