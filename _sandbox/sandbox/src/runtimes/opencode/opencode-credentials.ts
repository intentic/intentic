import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { discoveredCatalog } from "../../agent/models/model-catalog.js";
import { idCatalog } from "../../agent/models/model-discovery.js";
import { cacheFile } from "../../store/open-document.js";
import { discoverXaiModels, isChatModel, SEED_XAI_MODELS } from "./xai-models.js";

// What OpenCode holds for a provider's sign-in, read where OpenCode keeps it, without asking its server: whether Grok is
// connected is asked by health checks and the provider list all day, and a question must not boot a 300 MB runtime, nor
// keep one from its idle stop.
//
// OpenCode 2 keeps credentials in its SQLite database (`credential`, one row per account, the value a JSON document).
// OpenCode 1 kept them in auth.json, keyed by provider. The first OpenCode 2 boot on an OpenCode 1 data directory moves
// auth.json's entries into the table (migration 20260805200742_import_legacy_credentials) and leaves the file; from then
// on the table is the record. Until that boot, auth.json still is.

// The fields of a stored credential this daemon reads: the same in auth.json's entries and the table's values.
export interface StoredCredential {
    readonly type?: string;
    readonly access?: string;
    // ms epoch
    readonly expires?: number;
}

const asCredential = (value: unknown): StoredCredential | undefined =>
    typeof value === "object" && value !== null ? (value as StoredCredential) : undefined;

// The table's rows for one integration, or undefined where there is no table yet (no OpenCode 2 boot has migrated this
// directory), so the caller knows to read auth.json instead. An integration with several accounts lists the active one
// first; OpenCode leaves `active` unset on a lone credential.
const credentialsInDatabase = (database: string, integrationID: string): StoredCredential[] | undefined => {
    if (!existsSync(database)) {
        return undefined;
    }
    let db: DatabaseSync | undefined;
    try {
        db = new DatabaseSync(database, { readOnly: true });
        const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'credential'").get();
        if (table === undefined) {
            return undefined;
        }
        const rows = db
            .prepare("SELECT value FROM credential WHERE integration_id = ? ORDER BY active DESC, time_updated DESC")
            .all(integrationID) as { value: string }[];
        return rows.flatMap((row) => {
            try {
                const parsed = asCredential(JSON.parse(row.value));
                return parsed === undefined ? [] : [parsed];
            } catch {
                // allow(silent-catch): a row this daemon cannot read is one it cannot use
                return [];
            }
        });
    } catch {
        // allow(silent-catch): a database mid-write or locked reads as holding nothing this time; the next ask reads again
        return [];
    } finally {
        db?.close();
    }
};

export const openCodeCredentials = (opencodeDir: string) => {
    const authPath = join(opencodeDir, "auth.json");
    const databasePath = join(opencodeDir, "opencode.db");
    const legacy = async (providerID: string): Promise<StoredCredential | undefined> => {
        try {
            return asCredential((JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>)[providerID]);
        } catch {
            // allow(silent-catch): an absent or unreadable auth store holds no connected provider
            return undefined;
        }
    };
    const stored = async (providerID: string): Promise<StoredCredential | undefined> => {
        const rows = credentialsInDatabase(databasePath, providerID);
        return rows === undefined ? legacy(providerID) : rows[0];
    };
    return {
        stored,
        // Whether a provider holds an OAuth sign-in; an API key does not make Grok a subscription.
        connected: async (providerID: string): Promise<boolean> => {
            const credential = await stored(providerID);
            return credential?.type === "oauth" && typeof credential.access === "string";
        },
        // The legacy file only: the table's rows are removed through the server, which also forgets its own copy.
        forgetLegacy: () => rm(authPath, { force: true }),
    };
};

// xAI's model catalog: live discovery with the unexpired OAuth token, else the last persisted list, else the seed. Boot
// reads only persisted ids, without a round trip to api.x.ai.
export const createXaiCatalog = (
    opencodeDir: string,
    credential: () => Promise<StoredCredential | undefined>,
    fetchImpl: typeof fetch,
) => {
    const modelsPath = join(opencodeDir, "xai-models.json");
    const usableXaiToken = async (): Promise<string | undefined> => {
        const entry = await credential();
        if (entry?.type !== "oauth" || typeof entry.access !== "string") {
            return undefined;
        }
        return entry.expires === undefined || Date.now() < entry.expires ? entry.access : undefined;
    };
    const modelStore = cacheFile<string[]>(modelsPath, {
        parse: (raw) => (Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : undefined),
        fallback: () => [],
    });
    const models = discoveredCatalog({
        ttlMs: 60_000,
        discover: async () => {
            const token = await usableXaiToken();
            return token === undefined ? [] : await discoverXaiModels(token, fetchImpl);
        },
        idOf: (id) => id,
        store: modelStore,
        toStored: (ids) => [...ids],
        seed: SEED_XAI_MODELS,
        fromLive: idCatalog,
        fromStored: idCatalog,
    });
    return {
        persisted: modelStore.read,
        models: models.models,
        record: async (ids: string[]): Promise<void> => {
            // A vendor's suggestions can name media endpoints; an empty result must not replace the known-good list.
            const valid = [...new Set(ids.filter(isChatModel))];
            if (valid.length > 0) {
                await models.record(valid);
            }
        },
        forget: async (): Promise<void> => {
            models.forget();
            await rm(modelsPath, { force: true });
        },
    };
};
