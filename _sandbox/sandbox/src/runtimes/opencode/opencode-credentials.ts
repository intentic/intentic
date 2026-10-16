import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openSqlite } from "@intentic/base/sqlite";
import { z } from "zod";
import { discoveredCatalog } from "../../agent/models/model-catalog.js";
import { idCatalog } from "../../agent/models/model-discovery.js";
import { cacheFile } from "../../store/open-document.js";
import { discoverXaiModels, isChatModel, SEED_XAI_MODELS, xaiEffortsOf } from "./xai-models.js";
import { parseJsonOr } from "@intentic/base/json";

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

// What node:sqlite's errors carry of SQLite's own: the result code. SQLITE_BUSY (5) and SQLITE_LOCKED (6) are read by
// their primary code, which an extended one (BUSY_RECOVERY, BUSY_SNAPSHOT) carries in its low byte.
const SqliteFailureSchema = z.object({ errcode: z.number().int() });
const BUSY_CODES = new Set([5, 6]);

// The table's rows for one integration, or undefined where there is no table yet (no OpenCode 2 boot has migrated this
// directory), so the caller knows to read auth.json instead. An integration with several accounts lists the active one
// first; OpenCode leaves `active` unset on a lone credential.
const credentialsInDatabase = (database: string, integrationID: string): StoredCredential[] | undefined => {
    if (!existsSync(database)) {
        return undefined;
    }
    let db: DatabaseSync | undefined;
    try {
        // Read-only, so nothing of OpenCode's is changed (no journal mode set), with a busy timeout: a read that meets
        // OpenCode's own write waits it out instead of failing at once.
        db = openSqlite(database, { readOnly: true });
        const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'credential'").get();
        if (table === undefined) {
            return undefined;
        }
        const rows = db
            .prepare("SELECT value FROM credential WHERE integration_id = ? ORDER BY active DESC, time_updated DESC")
            .all(integrationID) as { value: string }[];
        return rows.flatMap((row) => {
            // A row this daemon cannot read is one it cannot use.
            const parsed = asCredential(parseJsonOr(row.value, undefined));
            return parsed === undefined ? [] : [parsed];
        });
    } catch (error) {
        // Still locked after the wait says nothing about what is stored: answering "no credentials" would tell the caller
        // the account was signed out. Any other failure (a damaged or foreign file) holds nothing this daemon can use.
        const failure = SqliteFailureSchema.safeParse(error);
        if (failure.success && BUSY_CODES.has(failure.data.errcode % 256)) {
            throw error;
        }
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
        // Each model names the reasoning tiers xAI takes for it, where it takes any.
        models: async () => {
            const catalog = await models.models();
            return {
                ...catalog,
                models: catalog.models.map((model) => {
                    const efforts = xaiEffortsOf(model.id);
                    return efforts.length === 0 ? model : { ...model, efforts: [...efforts] };
                }),
            };
        },
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
