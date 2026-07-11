import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SshExecutor, SshTarget } from "@intentic/providers";
import { describe, expect, it } from "vitest";
import { createHostSecretStore, createLayeredSecretStore, createLocalSecretStore, type SecretStore } from "./secret-store.js";

const HOST_PATH = "/opt/intentic/secrets.json";
const target: SshTarget = { address: "10.0.0.1", user: "deploy", privateKey: "k", port: 22 };

// A fake host with a single secrets file, interpreting the two shapes createHostSecretStore emits: a `cat`
// read and a quoted-heredoc write. Counts SSH ops so we can assert the per-instance read cache.
const createFakeHost = (initial?: Record<string, string>) => {
    const files = new Map<string, string>();
    if (initial !== undefined) {
        files.set(HOST_PATH, JSON.stringify(initial));
    }
    let reads = 0;
    let writes = 0;
    const executor: SshExecutor = {
        connect: () =>
            Promise.resolve({
                exec: (command: string) => {
                    if (command.startsWith(`cat ${HOST_PATH}`)) {
                        reads++;
                        return Promise.resolve({ stdout: files.get(HOST_PATH) ?? "{}", stderr: "", code: 0 });
                    }
                    const written = command.match(/<<'INTENTIC_SECRETS_EOF'\n([\s\S]*?)\nINTENTIC_SECRETS_EOF/);
                    if (written !== null) {
                        writes++;
                        files.set(HOST_PATH, written[1]);
                    }
                    return Promise.resolve({ stdout: "", stderr: "", code: 0 });
                },
                dispose: () => Promise.resolve(),
            }),
    };
    return { executor, files, ops: () => ({ reads, writes }) };
};

// A trivial in-memory SecretStore for exercising the layered combinator without SSH.
const memStore = (initial?: Record<string, string>): SecretStore & { readonly map: Map<string, string> } => {
    const map = new Map<string, string>(Object.entries(initial ?? {}));
    return { map, get: (key) => Promise.resolve(map.get(key)), set: (key, value) => Promise.resolve(void map.set(key, value)) };
};

describe("createLocalSecretStore", () => {
    it("round-trips a value through the .secrets.json file at mode 0600", async () => {
        const dir = await mkdtemp(join(tmpdir(), "intentic-ss-"));
        const store = createLocalSecretStore(dir);
        expect(await store.get("K")).toBeUndefined();
        await store.set("K", "v");
        expect(await store.get("K")).toBe("v");
        expect(JSON.parse(await readFile(join(dir, ".secrets.json"), "utf8"))).toEqual({ K: "v" });
    });
});

describe("createHostSecretStore", () => {
    it("reads a key from the host file and caches the read for the rest of the pass", async () => {
        const host = createFakeHost({ FORGEJO_ADMIN_PASSWORD: "abc" });
        const store = createHostSecretStore(target, host.executor);
        expect(await store.get("FORGEJO_ADMIN_PASSWORD")).toBe("abc");
        expect(await store.get("FORGEJO_ADMIN_PASSWORD")).toBe("abc");
        expect(host.ops().reads).toBe(1);
    });

    it("returns undefined for an absent key (and an empty host file)", async () => {
        const host = createFakeHost();
        const store = createHostSecretStore(target, host.executor);
        expect(await store.get("MISSING")).toBeUndefined();
    });

    it("writes a key back to the host file as JSON the next reader can parse", async () => {
        const host = createFakeHost();
        const store = createHostSecretStore(target, host.executor);
        await store.set("KOMODO_ADMIN_PASSWORD", "xyz");
        expect(JSON.parse(host.files.get(HOST_PATH) ?? "{}")).toEqual({ KOMODO_ADMIN_PASSWORD: "xyz" });
        // A fresh store instance (fresh cache) reads the persisted value.
        expect(await createHostSecretStore(target, host.executor).get("KOMODO_ADMIN_PASSWORD")).toBe("xyz");
    });
});

describe("createLayeredSecretStore", () => {
    it("returns the most-authoritative (first) layer's value", async () => {
        const host = memStore({ K: "host-value" });
        const local = memStore({ K: "local-value" });
        const layered = createLayeredSecretStore([host, local], { backfill: false });
        expect(await layered.get("K")).toBe("host-value");
    });

    it("with backfill, promotes a value present only in the local cache up to the host layer", async () => {
        const host = memStore();
        const local = memStore({ FORGEJO_ADMIN_PASSWORD: "minted-locally" });
        const layered = createLayeredSecretStore([host, local], { backfill: true });
        expect(await layered.get("FORGEJO_ADMIN_PASSWORD")).toBe("minted-locally");
        expect(host.map.get("FORGEJO_ADMIN_PASSWORD")).toBe("minted-locally");
    });

    it("with backfill, mirrors a host-only value down to a fresh operator's local cache", async () => {
        const host = memStore({ FORGEJO_ADMIN_PASSWORD: "from-host" });
        const local = memStore();
        const layered = createLayeredSecretStore([host, local], { backfill: true });
        expect(await layered.get("FORGEJO_ADMIN_PASSWORD")).toBe("from-host");
        expect(local.map.get("FORGEJO_ADMIN_PASSWORD")).toBe("from-host");
    });

    it("without backfill, never mutates any layer on read", async () => {
        const host = memStore();
        const local = memStore({ K: "v" });
        const layered = createLayeredSecretStore([host, local], { backfill: false });
        await layered.get("K");
        expect(host.map.has("K")).toBe(false);
    });

    it("set writes every layer (a mint persists to host and local)", async () => {
        const host = memStore();
        const local = memStore();
        const layered = createLayeredSecretStore([host, local], { backfill: false });
        await layered.set("K", "v");
        expect(host.map.get("K")).toBe("v");
        expect(local.map.get("K")).toBe("v");
    });

    it("get skips a layer that throws and falls through to the next", async () => {
        const throwing: SecretStore = {
            get: () => Promise.reject(new Error("host unreachable")),
            set: () => Promise.reject(new Error("host unreachable")),
        };
        const local = memStore({ K: "cached" });
        const layered = createLayeredSecretStore([throwing, local], { backfill: false });
        expect(await layered.get("K")).toBe("cached");
    });

    it("set throws only when no layer accepts the write", async () => {
        const throwing: SecretStore = {
            get: () => Promise.resolve(undefined),
            set: () => Promise.reject(new Error("nope")),
        };
        const layered = createLayeredSecretStore([throwing], { backfill: false });
        await expect(layered.set("K", "v")).rejects.toThrow(/failed to persist generated secret "K"/);
    });
});
