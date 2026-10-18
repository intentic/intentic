ALTER TABLE "sandbox" ADD COLUMN "personSeenAt" TIMESTAMP(3);
-- Every boot announce was a person's or the platform's before the hosted alarm, so the last one stands in for a person.
UPDATE "sandbox" SET "personSeenAt" = "lastSeenAt" WHERE "lastSeenAt" IS NOT NULL;
