-- Two things the platform keeps so that forgetting a sandbox stops looking like deleting it (platform.md, "When the
-- platform forgets"): this database's identity, minted here once, and a deletion record per tunnel id the registry
-- lets go of, written by a trigger so that no delete path, a cascade included, can skip it. The edge refuses a tunnel
-- only for a recorded id. Sandboxes deleted before this migration left no record, so the edge now serves their ids as
-- unknown; a deleted sandbox's own container is the only thing that could still dial one.

-- CreateTable
CREATE TABLE "sandbox_tombstone" (
    "tunnelId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandbox_tombstone_pkey" PRIMARY KEY ("tunnelId")
);

-- CreateTable
CREATE TABLE "platform_identity" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "identity" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_identity_pkey" PRIMARY KEY ("id")
);

-- This database's identity: random, and minted only here, so a fresh or foreign database answers with another one.
INSERT INTO "platform_identity" ("id", "identity") VALUES (1, gen_random_uuid()::text);

-- Records the tunnel id a sandbox row gives up, on a delete and on a token rotation alike.
CREATE FUNCTION "sandbox_tombstone_record"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD."tunnelId" <> '' THEN
        INSERT INTO "sandbox_tombstone" ("tunnelId") VALUES (OLD."tunnelId") ON CONFLICT ("tunnelId") DO NOTHING;
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "sandbox_tombstone_on_delete" AFTER DELETE ON "sandbox"
    FOR EACH ROW EXECUTE FUNCTION "sandbox_tombstone_record"();

CREATE TRIGGER "sandbox_tombstone_on_rotate" AFTER UPDATE OF "tunnelId" ON "sandbox"
    FOR EACH ROW WHEN (OLD."tunnelId" IS DISTINCT FROM NEW."tunnelId") EXECUTE FUNCTION "sandbox_tombstone_record"();
