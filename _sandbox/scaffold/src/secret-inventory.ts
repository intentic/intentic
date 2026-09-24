import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { collectSecretUsage, type DesiredStateGraph } from "@intentic/graph";
import type { SecretInventoryEntry } from "@intentic/sandbox-contract";
import { ARTIFACT_FILE } from "./workspace-layout.js";

const ENV_FILE = ".env";
const SECRETS_FILE = ".secrets.json";
// Digests of secrets last pushed to CI; the only way to tell current from stale, since CI can't read them back.
export const SYNC_FILE = ".secrets-sync.json";

export const secretDigest = (value: string): string => createHash("sha256").update(value).digest("hex");

export type SyncState = Readonly<Record<string, { readonly digest: string; readonly pushedAt: string }>>;

// Undefined only for a file that is not there; one that cannot be read or parsed throws, since "absent" here means
// "never adopted" or "nothing set", and a push or an inventory built on that would silently skip every secret.
const readText = async (path: string): Promise<string | undefined> => {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
};

const readJson = async <T>(path: string): Promise<T | undefined> => {
    const text = await readText(path);
    if (text === undefined) {
        return undefined;
    }
    try {
        return JSON.parse(text) as T;
    } catch {
        // Named, never quoted: the parse error's own message carries the text around the fault, which is secret values.
        throw new SyntaxError(`${path} is not valid JSON`);
    }
};

export const readSyncState = async (dir: string): Promise<SyncState> => (await readJson<SyncState>(join(dir, SYNC_FILE))) ?? {};

// Temp-then-rename: a push reading while another writes sees a whole record, never a torn one it cannot parse.
export const writeSyncState = async (dir: string, state: SyncState): Promise<void> => {
    const path = join(dir, SYNC_FILE);
    const staged = `${path}.${process.pid}.tmp`;
    await writeFile(staged, `${JSON.stringify(state, undefined, 4)}\n`, { mode: 0o600 });
    await rename(staged, path);
};

// Aggregates the secrets inventory: what the artifact requires, what .env/.secrets.json set (digest-compared against
// CI, never returned), and CI staleness. Keys set in .env but unreferenced still appear, with an empty requiredBy.
export const collectSecretInventory = async (dir: string): Promise<SecretInventoryEntry[]> => {
    // Four independent reads, each degrading to a default on absence only; resolved concurrently.
    const [graph, envRaw, generated, sync] = await Promise.all([
        readJson<DesiredStateGraph>(join(dir, ARTIFACT_FILE)),
        readText(join(dir, ENV_FILE)).then((text) => text ?? ""),
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
