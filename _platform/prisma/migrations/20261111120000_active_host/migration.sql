-- Which copy of a sandbox runs it (api active-host.ts). One connect token held by two containers had the edge keep
-- whichever dialled first, a stale copy included; the row now names one active host, set by the first copy to announce
-- and moved since only by an announce carrying a newer takeover marker (`ic sandbox claim`, a move). activeEpoch counts
-- those takeovers.

-- AlterTable
ALTER TABLE "sandbox" ADD COLUMN "activeHost" JSONB,
ADD COLUMN "activeEpoch" INTEGER NOT NULL DEFAULT 0;

-- Backfill: the copy that announced last (seenInstances keeps the announcing copy first, so its newest `at` wins), when
-- it named its host; since its first announce, so any later takeover is newer. Its manager is not known yet, and its
-- next announce says nothing that changes it (rule (c)), so `other` stands until a takeover.
UPDATE "sandbox" AS s
SET "activeHost" = jsonb_strip_nulls(jsonb_build_object(
        'host', newest.copy->>'host',
        'os', newest.copy->>'os',
        'env', newest.copy->>'engine',
        'manager', 'other',
        'since', newest.copy->>'firstAt'
    ))
FROM (
    SELECT DISTINCT ON (inner_s."id") inner_s."id" AS id, copy
    FROM "sandbox" AS inner_s, jsonb_array_elements(inner_s."seenInstances") AS copy
    WHERE jsonb_typeof(inner_s."seenInstances") = 'array'
      AND copy->>'host' IS NOT NULL
      AND copy->>'host' <> ''
      AND copy->>'firstAt' IS NOT NULL
    ORDER BY inner_s."id", copy->>'at' DESC
) AS newest
WHERE s."id" = newest.id AND s."activeHost" IS NULL;
