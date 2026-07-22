import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { collectSecretUsage, type DesiredStateGraph } from "@intentic/graph";
import type { SecretInventoryEntry } from "@intentic/sandbox-contract";

const ARTIFACT_FILE = "desired-state.json";
const ENV_FILE = ".env";
const SECRETS_FILE = ".secrets.json";
// Digests of the secret values last pushed to Forgejo Actions (`adopt` / `intentic secrets push`). Forgejo
// cannot read secrets back, so this local record is the only way to tell "CI has the current value" from
// "CI is stale". Gitignored and on the daemon's file denylist, like the value files beside it.
export const SYNC_FILE = ".secrets-sync.json";

export const secretDigest = (value: string): string => createHash("sha256").update(value).digest("hex");

export type SyncState = Readonly<Record<string, { readonly digest: string; readonly pushedAt: string }>>;

const readJson = async <T>(path: string): Promise<T | undefined> => {
    try {
        return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
        return undefined;
    }
};

export const readSyncState = async (dir: string): Promise<SyncState> => (await readJson<SyncState>(join(dir, SYNC_FILE))) ?? {};

export const writeSyncState = async (dir: string, state: SyncState): Promise<void> => {
    await writeFile(join(dir, SYNC_FILE), `${JSON.stringify(state, undefined, 4)}\n`, { mode: 0o600 });
};

// The env|generated slice of the secrets inventory, aggregated from one desired-state checkout: the artifact's
// {$secret} refs (what the intent REQUIRES and which resources consume each key), .env / .secrets.json keys
// (what is SET — values are read only to digest-compare against the CI sync record, never returned), and the
// sync record (CI staleness). Keys set in .env but not referenced by the artifact still appear (requiredBy [])
// — the user put them there, so they must be visible and removable. Capability/provider entries are the
// daemon's to add — they live in its stores, not in this repo.
export const collectSecretInventory = async (dir: string): Promise<SecretInventoryEntry[]> => {
    // Four independent reads (each already degrades to a default on absence) — resolve them concurrently.
    const [graph, envRaw, generated, sync] = await Promise.all([
        readJson<DesiredStateGraph>(join(dir, ARTIFACT_FILE)),
        readFile(join(dir, ENV_FILE), "utf8").catch(() => ""),
        readJson<Record<string, string>>(join(dir, SECRETS_FILE)),
        readSyncState(dir),
    ]);
    const usage = graph === undefined ? [] : collectSecretUsage(graph);
    const envValues = parseEnv(envRaw);
    const generatedValues = generated ?? {};
    const adopted = Object.keys(sync).length > 0;

    const entry = (key: string, kind: "env" | "generated", requiredBy: SecretInventoryEntry["requiredBy"]): SecretInventoryEntry => {
        const value = kind === "env" ? envValues[key] : generatedValues[key];
        const record = sync[key];
        return {
            key,
            kind,
            status: value === undefined ? "missing" : "set",
            requiredBy,
            storedAt: kind === "env" ? `desired-state/${ENV_FILE}` : `desired-state/${SECRETS_FILE}`,
            revealable: true,
            ...(adopted && value !== undefined
                ? {
                      ci: {
                          synced: record !== undefined && record.digest === secretDigest(value),
                          ...(record !== undefined ? { pushedAt: record.pushedAt } : {}),
                      },
                  }
                : {}),
        };
    };

    const declared = usage.map((u) =>
        entry(
            u.key,
            u.source,
            u.requiredBy.map(({ id, type }) => ({ resourceId: id, type })),
        ),
    );
    const declaredKeys = new Set(usage.map((u) => u.key));
    const undeclared = Object.keys(envValues)
        .filter((key) => !declaredKeys.has(key))
        .toSorted()
        .map((key) => entry(key, "env", []));
    return [...declared, ...undeclared];
};
