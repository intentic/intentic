import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CredentialEntry, OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import { humanizeModelId } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { createOpenCodeService, type OpenCodeService } from "./opencode.js";
import { createXaiCatalog, openCodeCredentials } from "./opencode-credentials.js";
import type { ServedServer } from "./opencode-serve.js";

// Where OpenCode keeps a sign-in, read off disk without asking its server: OpenCode 2's SQLite database once a boot has
// migrated the directory, OpenCode 1's auth.json until then. And xAI's catalog over that sign-in: live with an unexpired
// token, else the persisted list, else the seed. Real temp directories, real SQLite files.

// The `credential` table exactly as OpenCode 2.0.26 creates it (copied from a database a real server wrote).
const CREDENTIAL_TABLE = `CREATE TABLE \`credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        )`;

// A value as OpenCode 2 files an xAI device sign-in (the shape a real migrated row holds), and an API key's.
const oauth = (token: string, expires: number) => ({ type: "oauth", methodID: "device", refresh: `refresh-${token}`, access: token, expires });
const apiKey = { type: "key", key: "xai-api-key" };
const HOUR = 3_600_000;

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(async () => {
    for (const db of databases.splice(0)) {
        db.close();
    }
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// An XDG data home and the opencode directory inside it, where OpenCode and this daemon both keep their files.
const scratch = async (): Promise<{ xdg: string; dir: string }> => {
    const xdg = await mkdtemp(join(tmpdir(), "opencode-"));
    roots.push(xdg);
    const dir = join(xdg, "opencode");
    await mkdir(dir, { recursive: true });
    return { xdg, dir };
};

interface Row {
    readonly id: string;
    readonly integration: string;
    readonly value: unknown;
    // The column's text as written, for a value that is not JSON at all.
    readonly text?: string;
    // OpenCode leaves it unset on a lone credential.
    readonly active?: 0 | 1;
    readonly updated?: number;
}

// The database a running OpenCode 2 server holds open: WAL, its connection kept, so a row it just wrote may still sit in
// the log rather than the main file when the daemon reads.
const migratedDatabase = (dir: string, rows: readonly Row[] = []) => {
    const db = new DatabaseSync(join(dir, "opencode.db"));
    databases.push(db);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(CREDENTIAL_TABLE);
    const add = (row: Row): void => {
        const updated = row.updated ?? 1_791_000_000_000;
        db.prepare(
            "INSERT INTO credential (id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)",
        ).run(row.id, row.integration, "OAuth", row.text ?? JSON.stringify(row.value), row.active ?? null, updated, updated);
    };
    for (const row of rows) {
        add(row);
    }
    return { db, add };
};

// OpenCode 1's store, keyed by provider; still the record until an OpenCode 2 boot migrates the directory.
const writeAuth = async (dir: string, auth: unknown): Promise<void> => {
    await writeFile(join(dir, "auth.json"), JSON.stringify(auth));
};

const exists = async (path: string): Promise<boolean> =>
    access(path)
        .then(() => true)
        .catch(() => false);

// Every request discovery made, each answered by `answer`.
const recordingFetch = (answer: (url: string) => Response) => {
    const requests: { url: string; authorization: string | null }[] = [];
    const fetchImpl: typeof fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const url = String(input);
            requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
            return answer(url);
        },
        { preconnect: () => undefined },
    );
    return { fetchImpl, requests };
};
// For a case that must not reach the network: any request fails the read that made it, and is recorded.
const offline = (url: string): Response => {
    throw new Error(`no request expected, got ${url}`);
};
const listing = (ids: readonly string[]) => (url: string) =>
    url === "https://api.x.ai/v1/models" ? new Response(JSON.stringify({ data: ids.map((id) => ({ id })) })) : new Response("{}", { status: 404 });

// The catalog as served: the ids in the order it ranks them, the first its default.
const catalogOf = (head: string, ...rest: string[]) => ({ models: [head, ...rest].map((id) => ({ id, label: humanizeModelId(id) })), default: head });
const SEED_CATALOG = catalogOf("grok-4", "grok-3");

// The xAI catalog as the service wires it: over the credential OpenCode holds for xai.
const xaiCatalog = (dir: string, fetchImpl: typeof fetch) => {
    const credentials = openCodeCredentials(dir);
    return createXaiCatalog(dir, () => credentials.stored("xai"), fetchImpl);
};

describe("whether a provider is connected", () => {
    test("an OAuth sign-in in OpenCode 2's table connects xai, read afresh on every ask", async () => {
        const { dir } = await scratch();
        const credentials = openCodeCredentials(dir);
        const { add } = migratedDatabase(dir);
        expect(await credentials.connected("xai")).toBe(false);

        // Written by the running server after the first ask: no restart, no cache, the next ask sees it.
        add({ id: "cred_xai", integration: "xai", value: oauth("tok", Date.now() + HOUR) });

        expect(await credentials.connected("xai")).toBe(true);
    });

    test("an API key is not a subscription, and another integration's sign-in is not xai's", async () => {
        const { dir } = await scratch();
        const credentials = openCodeCredentials(dir);
        const { add } = migratedDatabase(dir, [{ id: "cred_key", integration: "xai", value: apiKey }]);
        expect(await credentials.connected("xai")).toBe(false);

        add({ id: "cred_other", integration: "anthropic", value: oauth("tok", Date.now() + HOUR) });
        expect(await credentials.connected("xai")).toBe(false);
        expect(await credentials.connected("anthropic")).toBe(true);
    });

    test("before any OpenCode 2 boot (no database), auth.json is the record", async () => {
        const { dir } = await scratch();
        const credentials = openCodeCredentials(dir);
        expect(await credentials.connected("xai")).toBe(false);

        await writeAuth(dir, { xai: { type: "oauth", access: "tok", refresh: "r", expires: 1 } });
        expect(await credentials.connected("xai")).toBe(true);

        await writeAuth(dir, { xai: { type: "api", key: "sk-xxx" } });
        expect(await credentials.connected("xai")).toBe(false);
        await writeAuth(dir, { anthropic: { type: "oauth", access: "tok" } });
        expect(await credentials.connected("xai")).toBe(false);
    });

    test("a database without the credential table has not been migrated yet, so auth.json is still the record", async () => {
        const { dir } = await scratch();
        const db = new DatabaseSync(join(dir, "opencode.db"));
        databases.push(db);
        db.exec("CREATE TABLE `kv` (`key` text PRIMARY KEY, `value` text)");
        const legacy = { type: "oauth", access: "legacy-tok", refresh: "r", expires: 1 };
        await writeAuth(dir, { xai: legacy });

        expect(await openCodeCredentials(dir).stored("xai")).toEqual(legacy);
    });

    // The first OpenCode 2 boot moves auth.json's entries into the table and leaves the file: a sign-out after that
    // empties the table, and the stale file must not sign the account back in.
    test("once the table exists, auth.json is ignored, even with the table empty", async () => {
        const { dir } = await scratch();
        await writeAuth(dir, { xai: { type: "oauth", access: "legacy-tok", refresh: "r", expires: 1 } });
        migratedDatabase(dir);

        const credentials = openCodeCredentials(dir);
        expect(await credentials.stored("xai")).toBeUndefined();
        expect(await credentials.connected("xai")).toBe(false);
    });

    test("of several accounts, the active one is read, else the newest", async () => {
        const { dir } = await scratch();
        const signedIn = oauth("old-tok", Date.now() + HOUR);
        const { add } = migratedDatabase(dir, [
            { id: "cred_old", integration: "xai", value: signedIn, active: 1, updated: 1_000 },
            { id: "cred_new", integration: "xai", value: apiKey, active: 0, updated: 2_000 },
        ]);
        const credentials = openCodeCredentials(dir);
        expect(await credentials.stored("xai")).toEqual(signedIn);
        expect(await credentials.connected("xai")).toBe(true);

        // No account marked active: the newest wins.
        add({ id: "cred_a", integration: "grok-team", value: oauth("a-tok", 1), updated: 1_000 });
        add({ id: "cred_b", integration: "grok-team", value: oauth("b-tok", 2), updated: 3_000 });
        expect(await credentials.stored("grok-team")).toEqual(oauth("b-tok", 2));
    });

    test("a row it cannot parse is passed over for the next one", async () => {
        const { dir } = await scratch();
        migratedDatabase(dir, [
            { id: "cred_bad", integration: "xai", value: undefined, text: "{not json", updated: 2_000 },
            { id: "cred_good", integration: "xai", value: oauth("tok", 5), updated: 1_000 },
        ]);

        expect(await openCodeCredentials(dir).stored("xai")).toEqual(oauth("tok", 5));
    });
});

describe("xAI's model catalog", () => {
    test("with no sign-in, the seed is served without a request: never blank", async () => {
        const { dir } = await scratch();
        const { fetchImpl, requests } = recordingFetch(offline);

        expect(await xaiCatalog(dir, fetchImpl).models()).toEqual(SEED_CATALOG);
        expect(requests).toEqual([]);
    });

    test("an API key cannot list a subscription's models: the seed, without a request", async () => {
        const { dir } = await scratch();
        migratedDatabase(dir, [{ id: "cred_key", integration: "xai", value: apiKey }]);
        const { fetchImpl, requests } = recordingFetch(offline);

        expect(await xaiCatalog(dir, fetchImpl).models()).toEqual(SEED_CATALOG);
        expect(requests).toEqual([]);
    });

    // Every discovery probe would 401 on an expired token, so it must not even try.
    test("with an expired token, the persisted list is served without a request", async () => {
        const { dir } = await scratch();
        migratedDatabase(dir, [{ id: "cred_xai", integration: "xai", value: oauth("tok", Date.now() - 1) }]);
        await writeFile(join(dir, "xai-models.json"), JSON.stringify(["grok-4.20-0309-reasoning"]));
        const { fetchImpl, requests } = recordingFetch(offline);

        expect(await xaiCatalog(dir, fetchImpl).models()).toEqual(catalogOf("grok-4.20-0309-reasoning"));
        expect(requests).toEqual([]);
    });

    test("with an unexpired token, the catalog is discovered live with it, chat models only, and persisted", async () => {
        const { dir } = await scratch();
        migratedDatabase(dir, [{ id: "cred_xai", integration: "xai", value: oauth("live-tok", Date.now() + HOUR) }]);
        const { fetchImpl, requests } = recordingFetch(listing(["grok-4-latest", "grok-imagine-video", "grok-3-mini"]));
        const catalog = xaiCatalog(dir, fetchImpl);

        expect(await catalog.models()).toEqual(catalogOf("grok-4-latest", "grok-3-mini"));
        expect(requests).toEqual([{ url: "https://api.x.ai/v1/models", authorization: "Bearer live-tok" }]);
        // Persisted, so a later boot or an expired-token read still serves the real catalog.
        expect(JSON.parse(await readFile(join(dir, "xai-models.json"), "utf8"))).toEqual(["grok-4-latest", "grok-3-mini"]);
        expect(await catalog.persisted()).toEqual(["grok-4-latest", "grok-3-mini"]);
    });

    test("an unexpired token in auth.json, before any OpenCode 2 boot, is discovered with too", async () => {
        const { dir } = await scratch();
        await writeAuth(dir, { xai: { type: "oauth", access: "legacy-tok", refresh: "r", expires: Date.now() + HOUR } });
        const { fetchImpl, requests } = recordingFetch(listing(["grok-4-latest"]));

        expect(await xaiCatalog(dir, fetchImpl).models()).toEqual(catalogOf("grok-4-latest"));
        expect(requests).toEqual([{ url: "https://api.x.ai/v1/models", authorization: "Bearer legacy-tok" }]);
    });

    test("a model list a turn proved is kept chat-only and served next", async () => {
        const { dir } = await scratch();
        const { fetchImpl } = recordingFetch(offline);
        const catalog = xaiCatalog(dir, fetchImpl);

        // Media ids are dropped and a repeat collapses; the survivors are persisted and become the catalog and its default.
        await catalog.record(["grok-4", "grok-2-image", "grok-3", "grok-4"]);

        expect(JSON.parse(await readFile(join(dir, "xai-models.json"), "utf8"))).toEqual(["grok-4", "grok-3"]);
        expect(await catalog.models()).toEqual(catalogOf("grok-4", "grok-3"));
        // A fresh read of the file, as the next boot's store opt-out reads it.
        expect(await xaiCatalog(dir, fetchImpl).persisted()).toEqual(["grok-4", "grok-3"]);
    });

    test("an empty or media-only list replaces nothing: the seed floor, or the list already kept", async () => {
        const { dir } = await scratch();
        const { fetchImpl } = recordingFetch(offline);
        const catalog = xaiCatalog(dir, fetchImpl);

        await catalog.record([]);
        await catalog.record(["grok-2-image", "grok-imagine-video"]);
        expect(await exists(join(dir, "xai-models.json"))).toBe(false);
        expect(await catalog.models()).toEqual(SEED_CATALOG);

        await catalog.record(["grok-4"]);
        await catalog.record(["grok-imagine-video"]);
        expect(JSON.parse(await readFile(join(dir, "xai-models.json"), "utf8"))).toEqual(["grok-4"]);
        expect(await catalog.models()).toEqual(catalogOf("grok-4"));
    });

    test("forgetting drops the cached answer and the persisted list, so a signed-out account serves the seed at once", async () => {
        const { dir } = await scratch();
        const { db } = migratedDatabase(dir, [{ id: "cred_xai", integration: "xai", value: oauth("tok", Date.now() + HOUR) }]);
        const { fetchImpl } = recordingFetch(listing(["grok-4-latest"]));
        const catalog = xaiCatalog(dir, fetchImpl);
        expect(await catalog.models()).toEqual(catalogOf("grok-4-latest"));

        db.prepare("DELETE FROM credential WHERE id = ?").run("cred_xai");
        await catalog.forget();

        expect(await exists(join(dir, "xai-models.json"))).toBe(false);
        expect(await catalog.models()).toEqual(SEED_CATALOG);
    });

    // A different account signing in within the grace window (ABSENT_FOR_MS) was once served, and had persisted, the
    // signed-out account's models after its own, which its token cannot run.
    test("after forgetting, the next account's catalog is its own, without the signed-out account's models", async () => {
        const { dir } = await scratch();
        const { db, add } = migratedDatabase(dir, [{ id: "cred_first", integration: "xai", value: oauth("first-tok", Date.now() + HOUR) }]);
        let listed: readonly string[] = ["grok-4-heavy", "grok-4-latest"];
        const { fetchImpl } = recordingFetch((url) => listing(listed)(url));
        const catalog = xaiCatalog(dir, fetchImpl);
        expect(await catalog.models()).toEqual(catalogOf("grok-4-latest", "grok-4-heavy"));

        db.prepare("DELETE FROM credential WHERE id = ?").run("cred_first");
        await catalog.forget();
        add({ id: "cred_second", integration: "xai", value: oauth("second-tok", Date.now() + HOUR) });
        listed = ["grok-4-latest"];

        expect(await catalog.models()).toEqual(catalogOf("grok-4-latest"));
        expect(JSON.parse(await readFile(join(dir, "xai-models.json"), "utf8"))).toEqual(["grok-4-latest"]);
    });
});

describe("signing out", () => {
    // The table's rows go through the server, which also drops its own copy; the file is the daemon's to remove.
    test("forgetting the legacy store removes auth.json only, and is quiet when there is none", async () => {
        const { dir } = await scratch();
        migratedDatabase(dir, [{ id: "cred_xai", integration: "xai", value: oauth("tok", Date.now() + HOUR) }]);
        await writeAuth(dir, { xai: { type: "oauth", access: "legacy-tok" } });
        const credentials = openCodeCredentials(dir);

        await credentials.forgetLegacy();
        await credentials.forgetLegacy();

        expect(await exists(join(dir, "auth.json"))).toBe(false);
        expect(await credentials.connected("xai")).toBe(true);
    });

    // A server that answers only what a sign-out asks of it, from the database it owns: its credential list and removal.
    const credentialServer = (db: DatabaseSync) => {
        const removed: string[] = [];
        const list = async (): Promise<CredentialEntry[]> =>
            db
                .prepare("SELECT id, integration_id, label, active, value FROM credential")
                .all()
                .map((row) => ({
                    id: String(row["id"]),
                    integrationID: String(row["integration_id"]),
                    label: String(row["label"]),
                    active: row["active"] === 1,
                    value: JSON.parse(String(row["value"])),
                }));
        const remove = async ({ credentialID }: { readonly credentialID: string }): Promise<void> => {
            removed.push(credentialID);
            db.prepare("DELETE FROM credential WHERE id = ?").run(credentialID);
        };
        const connected: OpenCodeEvent = { id: "evt_connected", type: "server.connected", data: {} };
        async function* subscribe(options?: { readonly signal?: AbortSignal }): AsyncGenerator<OpenCodeEvent> {
            yield connected;
            // Open until the service lets it go, as the real stream is.
            await new Promise<void>((resolve) => {
                if (options?.signal?.aborted === true) {
                    resolve();
                    return;
                }
                options?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
        }
        const client = unstubbed<OpenCodeClient>("client", {
            event: unstubbed<OpenCodeClient["event"]>("event", { subscribe }),
            credential: unstubbed<OpenCodeClient["credential"]>("credential", { list, remove }),
        });
        const served: ServedServer = { url: "http://127.0.0.1:4096", headers: {}, process: undefined, close: () => {}, onExit: () => {} };
        return { client, served, removed };
    };

    const services: OpenCodeService[] = [];
    afterEach(async () => {
        await Promise.all(services.splice(0).map((service) => service.stop()));
    });

    test("disconnect removes the provider's sign-ins through the server and forgets the legacy file and the catalog", async () => {
        const { xdg, dir } = await scratch();
        const { db } = migratedDatabase(dir, [
            { id: "cred_xai", integration: "xai", value: oauth("tok", Date.now() + HOUR), active: 1 },
            { id: "cred_xai_2", integration: "xai", value: apiKey, active: 0 },
            { id: "cred_other", integration: "anthropic", value: oauth("other-tok", Date.now() + HOUR) },
        ]);
        await writeAuth(dir, { xai: { type: "oauth", access: "legacy-tok" } });
        const server = credentialServer(db);
        const { fetchImpl } = recordingFetch(listing(["grok-4-latest"]));
        const service = createOpenCodeService(xdg, {
            fetchImpl,
            idleStopMs: 0,
            spawnServer: async () => server.served,
            makeClient: () => server.client,
        });
        services.push(service);
        expect(await service.connected("xai")).toBe(true);
        expect(await service.xaiModels()).toEqual(catalogOf("grok-4-latest"));

        await service.disconnect("xai");

        expect(server.removed.toSorted()).toEqual(["cred_xai", "cred_xai_2"]);
        expect(await service.connected("xai")).toBe(false);
        expect(await service.connected("anthropic")).toBe(true);
        expect(await exists(join(dir, "auth.json"))).toBe(false);
        expect(await exists(join(dir, "xai-models.json"))).toBe(false);
        expect(await service.xaiModels()).toEqual(SEED_CATALOG);
    });
});
