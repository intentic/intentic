import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { SECRETS_FILE } from "../lib/artifact.js";
import type { SecretStore } from "./secret-store.js";

type MutableEnv = Record<string, string | undefined>;

// Shell-safe hex: interpolated unquoted into `docker exec … --password` and the Komodo host `.env` echo. 128 bits,
// matching demo.ts's generator.
const generate = (): string => randomBytes(16).toString("hex");

// Env-first: a set `env[key]` is authoritative, so the apply pipeline can run inside Forgejo (no store there) without
// re-minting a password and locking everyone out. Otherwise reads or mints from the store once, persisted.
export const ensureGeneratedSecrets = async (store: SecretStore, keys: readonly string[], env: MutableEnv): Promise<void> => {
    for (const key of keys) {
        if (env[key] !== undefined && env[key] !== "") {
            continue;
        }
        const existing = await store.get(key);
        if (existing !== undefined) {
            env[key] = existing;
            continue;
        }
        const value = generate();
        await store.set(key, value);
        env[key] = value;
    }
};

// Read-only twin of ensureGeneratedSecrets for secrets only a pruned node still references: loads a stored value when
// there is one and never mints, since a fresh value for a resource being deleted is wrong by construction. A key no
// store holds stays unset (prune then deletes without it, or keeps the node pending), as does one a store cannot answer
// for. Returns the keys it could not load.
export const loadStoredSecrets = async (
    store: SecretStore,
    keys: readonly string[],
    env: MutableEnv,
    log: (message: string) => void,
): Promise<string[]> => {
    const unloaded: string[] = [];
    for (const key of keys) {
        if (env[key] !== undefined && env[key] !== "") {
            continue;
        }
        try {
            const existing = await store.get(key);
            if (existing === undefined) {
                unloaded.push(key);
                continue;
            }
            env[key] = existing;
        } catch (error) {
            log(`secrets: could not load "${key}" for a pruned resource, deleting without it: ${errorMessage(error)}`);
            unloaded.push(key);
        }
    }
    return unloaded;
};

// Reads generated secrets back as a map ({} if none), from the laptop-local .secrets.json cache tools have after an
// apply.
export const readGeneratedSecrets = async (dir: string): Promise<Record<string, string>> => {
    const path = join(dir, SECRETS_FILE);
    return existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as Record<string, string>) : {};
};
