import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SECRETS_FILE } from "../lib/artifact.js";
import type { SecretStore } from "./secret-store.js";

type MutableEnv = Record<string, string | undefined>;

// Shell-safe hex (the value is interpolated UNQUOTED into `docker exec … --password` and the Komodo host
// `.env` echo), 128 bits — matching demo.ts's randomBytes(16).toString("hex").
const generate = (): string => randomBytes(16).toString("hex");

// Ensure every intentic-generated secret has a value. Precedence is ENV-FIRST: an already-set `env[key]` is
// authoritative and neither reads nor writes the store. This is what lets the apply pipeline run inside Forgejo
// — it injects the generated secrets (Forgejo/Komodo admin passwords) from Forgejo Actions secrets, where the
// store does not exist; without env-first, a missing value would mint NEW passwords and lock us out
// (Forgejo/Komodo bake the password in on first init and will not re-key). When env is unset the value is read
// from the `store`, generated + persisted there ONCE and reused forever. The engine then resolves them from
// `env` like any secret. The store decides WHERE the value lives (local cache vs shared host); this policy is
// identical across backends.
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

// Read the generated secrets back as a map (or `{}` if none yet) — for tools that drive the CLI and then need
// the values, e.g. the demo/e2e signing into the Forgejo/Komodo they just provisioned. Always the laptop-local
// .secrets.json cache, which is what those tools have on hand after an apply.
export const readGeneratedSecrets = async (dir: string): Promise<Record<string, string>> => {
    const path = join(dir, SECRETS_FILE);
    return existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as Record<string, string>) : {};
};
