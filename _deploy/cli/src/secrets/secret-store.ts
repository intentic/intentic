import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOST_STATE_ROOT } from "@intentic/constants";
import { createStore, resolveInputs } from "@intentic/engine";
import type { DesiredStateGraph } from "@intentic/graph";
import { hostTarget, type SshExecutor, type SshTarget } from "@intentic/providers";
import { SECRETS_FILE } from "../lib/artifact.js";

// A key-value store for intentic's generated secrets. Storage only; env-first precedence and minting live in
// ensureGeneratedSecrets.
export interface SecretStore {
    readonly get: (key: string) => Promise<string | undefined>;
    readonly set: (key: string, value: string) => Promise<void>;
}

// The local backend: the gitignored .secrets.json beside the artifact (mode 0o600, 4-space JSON, trailing
// newline). `set` is read-modify-write.
export const createLocalSecretStore = (dir: string): SecretStore => {
    const path = join(dir, SECRETS_FILE);
    const read = async (): Promise<Record<string, string>> =>
        existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as Record<string, string>) : {};
    return {
        get: async (key) => (await read())[key],
        set: async (key, value) => {
            const store = await read();
            store[key] = value;
            await writeFile(path, `${JSON.stringify(store, undefined, 4)}\n`, { mode: 0o600 });
        },
    };
};

// The control-plane host is the authoritative home for generated secrets, so every operator reads the same
// value. Stored at /opt/intentic/secrets.json (mode 0600, root-only). A per-instance cache serves one ensure()
// pass; writes are read-modify-write of that cache.
const HOST_SECRETS_PATH = `${HOST_STATE_ROOT}/secrets.json`;
export const createHostSecretStore = (target: SshTarget, executor: SshExecutor): SecretStore => {
    // Memoize the load promise, success and failure alike, so an unreachable host pays one connect timeout for the
    // whole run rather than one per key.
    let loading: Promise<Record<string, string>> | undefined;
    const load = (): Promise<Record<string, string>> => {
        loading ??= (async () => {
            const session = await executor.connect(target);
            try {
                const result = await session.exec(`cat ${HOST_SECRETS_PATH} 2>/dev/null || echo '{}'`);
                return JSON.parse(result.stdout.trim() || "{}") as Record<string, string>;
            } finally {
                await session.dispose();
            }
        })();
        return loading;
    };
    return {
        get: async (key) => (await load())[key],
        set: async (key, value) => {
            const store = await load();
            store[key] = value;
            const json = JSON.stringify(store, undefined, 4);
            const session = await executor.connect(target);
            try {
                // Heredoc with a quoted delimiter writes the JSON body verbatim; write to a temp file then mv so a
                // concurrent
                // reader never sees a partial file.
                await session.exec(
                    `mkdir -p /opt/intentic && cat > ${HOST_SECRETS_PATH}.tmp <<'INTENTIC_SECRETS_EOF'\n${json}\nINTENTIC_SECRETS_EOF\nchmod 600 ${HOST_SECRETS_PATH}.tmp && mv ${HOST_SECRETS_PATH}.tmp ${HOST_SECRETS_PATH}`,
                );
            } finally {
                await session.dispose();
            }
        },
    };
};

// Compose stores into a precedence chain (most-authoritative first). `get` returns the first defined value; with
// `backfill` on, it reconciles every other layer to that value. `backfill` is off for read-only commands. `set`
// writes every layer.
export const createLayeredSecretStore = (
    layers: readonly SecretStore[],
    options: { readonly backfill: boolean; readonly log?: (message: string) => void },
): SecretStore => {
    const log = options.log ?? (() => {});
    return {
        get: async (key) => {
            const values: (string | undefined)[] = [];
            for (const layer of layers) {
                try {
                    values.push(await layer.get(key));
                } catch (error) {
                    log(`secret-store: a layer's read of "${key}" failed, skipping it: ${String(error)}`);
                    values.push(undefined);
                }
            }
            const result = values.find((value) => value !== undefined);
            if (result !== undefined && options.backfill) {
                for (const [i, layer] of layers.entries()) {
                    if (values[i] === result) {
                        continue;
                    }
                    try {
                        await layer.set(key, result);
                    } catch (error) {
                        log(`secret-store: failed to backfill "${key}" into a layer: ${String(error)}`);
                    }
                }
            }
            return result;
        },
        set: async (key, value) => {
            let persisted = false;
            for (const layer of layers) {
                try {
                    await layer.set(key, value);
                    persisted = true;
                } catch (error) {
                    log(`secret-store: a layer's write of "${key}" failed: ${String(error)}`);
                }
            }
            if (!persisted) {
                throw new Error(`failed to persist generated secret "${key}" to any store`);
            }
        },
    };
};

// Anchors the generated secrets (Forgejo/Komodo admin passwords) to the control-plane host (the Forgejo node's
// `server` ref) so every operator shares one value instead of minting a local one. The host node's inputs are
// pure SSH creds and resolve before the generated secrets exist. Falls back to the local cache alone when there
// is no Forgejo node or its host can't be found.
export const generatedSecretStore = (
    graph: DesiredStateGraph,
    dir: string,
    ssh: SshExecutor,
    backfill: boolean,
    log: (message: string) => void,
): SecretStore => {
    const local = createLocalSecretStore(dir);
    const forgejo = Object.values(graph.resources).find((node) => node.type === "forgejo");
    const serverRef = forgejo?.inputs["server"];
    const hostId =
        typeof serverRef === "object" && serverRef !== null && "$ref" in serverRef ? (serverRef as { readonly $ref: string }).$ref : undefined;
    const hostNode = hostId !== undefined ? graph.resources[hostId] : undefined;
    if (hostNode === undefined) {
        return local;
    }
    const target = hostTarget(resolveInputs(hostNode.inputs, createStore(), process.env, { lenient: false }));
    return createLayeredSecretStore([createHostSecretStore(target, ssh), local], { backfill, log });
};
