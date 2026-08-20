import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOST_STATE_ROOT } from "@intentic/constants";
import { createStore, resolveInputs } from "@intentic/engine";
import type { DesiredStateGraph } from "@intentic/graph";
import { hostTarget, type SshExecutor, type SshTarget } from "@intentic/providers";
import { SECRETS_FILE } from "../lib/artifact.js";

// A key→value store for intentic's generated secrets (the Forgejo/Komodo admin passwords). Storage only,
// mirroring HostKeyStore: env-first precedence and minting are policy, and live in ensureGeneratedSecrets, so
// the same policy runs over any backend. The local backend below is the laptop-local cache; a host-backed
// backend makes the authoritative copy shared across operators instead of local to whoever bootstrapped.
export interface SecretStore {
    readonly get: (key: string) => Promise<string | undefined>;
    readonly set: (key: string, value: string) => Promise<void>;
}

// The local backend: the gitignored .secrets.json beside the artifact (mode 0o600, 4-space JSON, trailing
// newline, the same on-disk conventions as .known-hosts.json). `set` is read-modify-write.
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

// The control-plane host is the authoritative home for generated secrets (the Forgejo/Komodo admin passwords),
// so every operator reads the SAME value instead of minting its own from a laptop-local cache. Stored at
// /opt/intentic/secrets.json (mode 0600, root-only), the same writable convention the backing providers use.
// A per-instance cache makes one read serve a whole ensure() pass; writes are read-modify-write of that cache.
const HOST_SECRETS_PATH = `${HOST_STATE_ROOT}/secrets.json`;
export const createHostSecretStore = (target: SshTarget, executor: SshExecutor): SecretStore => {
    // Memoize the load PROMISE, success and failure alike. One connect attempt serves the whole run: an
    // unreachable host must cost one connect timeout total, not one per generated key (the layered store
    // calls get() per key and used to re-pay the timeout each time when only successes were cached).
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
                // Heredoc with a QUOTED delimiter writes the JSON body verbatim (no shell expansion, safe for
                // arbitrary content); write to a temp file then mv so a concurrent reader never sees a partial file.
                await session.exec(
                    `mkdir -p /opt/intentic && cat > ${HOST_SECRETS_PATH}.tmp <<'INTENTIC_SECRETS_EOF'\n${json}\nINTENTIC_SECRETS_EOF\nchmod 600 ${HOST_SECRETS_PATH}.tmp && mv ${HOST_SECRETS_PATH}.tmp ${HOST_SECRETS_PATH}`,
                );
            } finally {
                await session.dispose();
            }
        },
    };
};

// Compose stores into a precedence chain (most-authoritative first, e.g. [host, local]). `get` returns the
// first defined value; with `backfill` on, it then reconciles every other layer to that value, so a secret
// minted into the local cache before the host existed is promoted to the host, and an operator who never
// bootstrapped has the host value mirrored back into their local cache for offline tooling. `backfill` is off
// for read-only commands (plan) so they never mutate a store. `set` writes every layer (mint persists to all).
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

// The generated secrets (Forgejo/Komodo admin passwords) are control-plane secrets whose authoritative home is
// the control-plane host, the host the Forgejo node runs on (its `server` ref). Anchoring there lets every
// operator share one value instead of minting its own laptop-local one (which would leave whoever didn't
// bootstrap unable to authenticate). The host node's inputs are pure SSH creds, so they resolve before the
// generated secrets exist, resolving the Forgejo node itself would need those very secrets. Falls back to the
// local cache alone when there is no Forgejo node or its host can't be found. `backfill` reconciles the layers
// (promote a locally-minted value to the host, mirror the host value back to a fresh operator's local cache);
// it is OFF for read-only commands so they never mutate a store.
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
