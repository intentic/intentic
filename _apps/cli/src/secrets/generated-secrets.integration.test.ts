import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureGeneratedSecrets, readGeneratedSecrets } from "./generated-secrets.js";
import { createLocalSecretStore } from "./secret-store.js";

const newDir = () => mkdtemp(join(tmpdir(), "intentic-gen-"));
const secretsPath = (dir: string) => join(dir, ".secrets.json");
const localStore = (dir: string) => createLocalSecretStore(dir);

describe("ensureGeneratedSecrets", () => {
    it("generates shell-safe hex values, persists them, and sets them into env", async () => {
        const dir = await newDir();
        const env: Record<string, string | undefined> = {};
        await ensureGeneratedSecrets(localStore(dir), ["FORGEJO_ADMIN_PASSWORD", "KOMODO_ADMIN_PASSWORD"], env);

        expect(env["FORGEJO_ADMIN_PASSWORD"]).toMatch(/^[0-9a-f]{32}$/);
        expect(env["KOMODO_ADMIN_PASSWORD"]).toMatch(/^[0-9a-f]{32}$/);
        expect(JSON.parse(await readFile(secretsPath(dir), "utf8"))).toEqual({
            FORGEJO_ADMIN_PASSWORD: env["FORGEJO_ADMIN_PASSWORD"],
            KOMODO_ADMIN_PASSWORD: env["KOMODO_ADMIN_PASSWORD"],
        });
    });

    it("reuses persisted values across calls (generate once, never re-key)", async () => {
        const dir = await newDir();
        const first: Record<string, string | undefined> = {};
        await ensureGeneratedSecrets(localStore(dir), ["FORGEJO_ADMIN_PASSWORD"], first);
        const stored = await readFile(secretsPath(dir), "utf8");

        const second: Record<string, string | undefined> = {};
        await ensureGeneratedSecrets(localStore(dir), ["FORGEJO_ADMIN_PASSWORD"], second);

        expect(second["FORGEJO_ADMIN_PASSWORD"]).toBe(first["FORGEJO_ADMIN_PASSWORD"]);
        expect(await readFile(secretsPath(dir), "utf8")).toBe(stored);
    });

    it("is env-first: an injected env value wins and is never persisted (the pipeline path)", async () => {
        const dir = await newDir();
        const env: Record<string, string | undefined> = { FORGEJO_ADMIN_PASSWORD: "from-forgejo-secret" };
        await ensureGeneratedSecrets(localStore(dir), ["FORGEJO_ADMIN_PASSWORD"], env);

        expect(env["FORGEJO_ADMIN_PASSWORD"]).toBe("from-forgejo-secret");
        // With env supplying the value, .secrets.json is neither needed nor written — which is exactly what
        // lets the pipeline run without the file (and never mint a new, locking-out password).
        expect(existsSync(secretsPath(dir))).toBe(false);
    });

    it("env-first does not override a persisted store value either (env wins, the store is left untouched)", async () => {
        const dir = await newDir();
        await ensureGeneratedSecrets(localStore(dir), ["FORGEJO_ADMIN_PASSWORD"], {});
        const stored = await readFile(secretsPath(dir), "utf8");

        const env: Record<string, string | undefined> = { FORGEJO_ADMIN_PASSWORD: "from-env" };
        await ensureGeneratedSecrets(localStore(dir), ["FORGEJO_ADMIN_PASSWORD"], env);
        expect(env["FORGEJO_ADMIN_PASSWORD"]).toBe("from-env");
        expect(await readFile(secretsPath(dir), "utf8")).toBe(stored);
    });

    it("is a no-op when there are no generated keys", async () => {
        const dir = await newDir();
        await ensureGeneratedSecrets(localStore(dir), [], {});
        expect(existsSync(secretsPath(dir))).toBe(false);
    });
});

describe("readGeneratedSecrets", () => {
    it("reads back what ensureGeneratedSecrets wrote, and is empty when nothing was generated", async () => {
        const dir = await newDir();
        expect(await readGeneratedSecrets(dir)).toEqual({});

        await ensureGeneratedSecrets(localStore(dir), ["FORGEJO_ADMIN_PASSWORD"], {});
        const secrets = await readGeneratedSecrets(dir);
        expect(secrets["FORGEJO_ADMIN_PASSWORD"]).toMatch(/^[0-9a-f]{32}$/);
    });
});
