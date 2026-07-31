import { type AccountUsage, TranslatorAccountsSchema } from "@intentic/sandbox-contract";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createCliProxyClient, nextRestartDelay, RESTART_DELAY_BASE_MS, RESTART_DELAY_CAP_MS } from "./translator.js";

/* The shared account-usage store, in memory. Every client in this file gets one: `accounts` reads it on every
 * call now that a row's headroom travels with the row, so a test that skipped it would be exercising a client
 * the daemon never builds. */
const memoryStore = () => {
    const snapshots: Record<string, AccountUsage> = {};
    return {
        snapshots,
        store: {
            read: async () => snapshots,
            record: async (account: string, usage: AccountUsage) => {
                snapshots[account] = usage;
            },
            clear: async (account: string) => {
                delete snapshots[account];
            },
        },
    };
};

// The restart ladder in one property: crash-on-arrival climbs, a stable run resets. This policy is what keeps
// a proxy that exits immediately (a taken port, a bad binary) from being respawned every 5s forever.

test("consecutive fast exits double the delay up to the cap", () => {
    let delay = RESTART_DELAY_BASE_MS;
    const seen: number[] = [];
    for (let i = 0; i < 8; i += 1) {
        delay = nextRestartDelay(delay, 100);
        seen.push(delay);
    }
    expect(seen).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, RESTART_DELAY_CAP_MS, RESTART_DELAY_CAP_MS, RESTART_DELAY_CAP_MS]);
});

test("a run that stayed up resets the ladder", () => {
    expect(nextRestartDelay(RESTART_DELAY_CAP_MS, 61_000)).toBe(RESTART_DELAY_BASE_MS);
});

afterEach(() => vi.unstubAllGlobals());

test("starts Kimi Code's headless device login through CLIProxyAPI", async () => {
    const fetchMock = vi.fn(async () =>
        Response.json({ url: "https://kimi.com/device?code=ABCD", user_code: "ABCD", state: "kmi-1", flow: "device" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createCliProxyClient({
        managementUrl: "http://127.0.0.1:8789/v0/management",
        token: "local",
        configPath: "/tmp/config.yaml",
        usageStore: memoryStore().store,
    });

    await expect(client.connect("kimi")).resolves.toEqual({
        url: "https://kimi.com/device?code=ABCD",
        code: "ABCD",
        state: "kmi-1",
        flow: "device",
    });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8789/v0/management/kimi-auth-url", {
        headers: { authorization: "Bearer local" },
    });
});

test("reads Kimi's provider-scoped model definitions without owned_by inference", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
            Response.json({
                channel: "kimi",
                models: [
                    {
                        id: "kimi-k3",
                        display_name: "Kimi K3",
                        description: "Flagship",
                        owned_by: "moonshot",
                        thinking: { levels: ["low", "high", "max"] },
                    },
                ],
            }),
        ),
    );
    const client = createCliProxyClient({
        managementUrl: "http://127.0.0.1:8789/v0/management",
        token: "local",
        configPath: "/tmp/config.yaml",
        usageStore: memoryStore().store,
    });

    await expect(client.models("kimi")).resolves.toEqual([
        { id: "kimi-k3", label: "Kimi K3", description: "Flagship", efforts: ["low", "high", "max"] },
    ]);
});

test("projects CLIProxyAPI's Kimi auth files as connected subscription accounts", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ files: [{ name: "kimi-user.json", provider: "kimi", label: "Kimi User" }] })),
    );
    const client = createCliProxyClient({
        managementUrl: "http://127.0.0.1:8789/v0/management",
        token: "local",
        configPath: "/tmp/config.yaml",
        usageStore: memoryStore().store,
    });

    await expect(client.accounts()).resolves.toEqual({
        codex: [],
        grok: [],
        kimi: [{ name: "kimi-user.json", label: "Kimi User" }],
        gemini: [],
    });
});

/* The routed accounts' quota path, end to end through the client. Two things are being pinned, and they are the
 * two that were actually broken: the rows have to carry `usage` at all (a green dot for a spent account is the
 * bug this exists to fix), and reading them must never put an upstream round-trip on `accounts` — which is the
 * routed-turn credential gate as well as the settings list. */
describe("translator subscription usage", () => {
    const cliProxyFetch = (calls: { url: string; body?: Record<string, unknown> }[]) =>
        (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            const url = String(input);
            const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
            calls.push({ url, ...(body === undefined ? {} : { body }) });
            if (url.endsWith("/auth-files")) {
                return Response.json({
                    files: [
                        {
                            name: "codex-a.json",
                            provider: "codex",
                            email: "chat@example.com",
                            auth_index: "codex-index",
                            id_token: { chatgpt_account_id: "chatgpt-account" },
                        },
                        {
                            name: "google-a.json",
                            provider: "antigravity",
                            email: "google@example.com",
                            auth_index: "google-index",
                            project_id: "google-project",
                        },
                        // Grok has no readable quota — it must never reach the api-call path.
                        { name: "grok-a.json", provider: "xai", email: "grok@example.com", auth_index: "grok-index" },
                    ],
                });
            }
            if (body?.[`url`] === "https://chatgpt.com/backend-api/wham/usage") {
                return Response.json({
                    status_code: 200,
                    body: JSON.stringify({ rate_limit: { primary_window: { used_percent: 41, limit_window_seconds: 18_000 } } }),
                });
            }
            return Response.json({
                status_code: 200,
                body: JSON.stringify({
                    groups: [{ displayName: "Google", buckets: [{ bucketId: "weekly", remainingFraction: 0.3 }] }],
                }),
            });
        }) as typeof fetch;

    test("records every readable account's quota and serves it on the rows without exposing its token", async () => {
        const calls: { url: string; body?: Record<string, unknown> }[] = [];
        const { store, snapshots } = memoryStore();
        const client = createCliProxyClient({
            managementUrl: "http://cliproxy.test",
            token: "management-secret",
            configPath: "/tmp/config",
            usageStore: store,
            fetchFn: cliProxyFetch(calls),
        });

        await client.refreshUsage();
        const accounts = await client.accounts();

        expect(() => TranslatorAccountsSchema.parse(accounts)).not.toThrow();
        expect(accounts.codex[0]).toMatchObject({
            name: "codex-a.json",
            label: "chat@example.com",
            usage: { windows: [{ kind: "five_hour", utilization: 41 }] },
        });
        expect(accounts.gemini[0]).toMatchObject({
            name: "google-a.json",
            label: "google@example.com",
            usage: { windows: [{ kind: "google:weekly", utilization: 70 }] },
        });
        // Namespaced by provider, because the store is shared with the native accounts and an auth-file name is
        // only unique within its own provider.
        expect(Object.keys(snapshots).toSorted()).toEqual(["codex:codex-a.json", "gemini:google-a.json"]);

        const proxied = calls.filter((call) => call.url.endsWith("/api-call")).map((call) => call.body!);
        expect(proxied.find((call) => call[`auth_index`] === "codex-index")?.[`header`]).toMatchObject({
            Authorization: "Bearer $TOKEN$",
            "Chatgpt-Account-Id": "chatgpt-account",
        });
        expect(proxied.find((call) => call[`auth_index`] === "google-index")).toMatchObject({
            data: JSON.stringify({ project: "google-project" }),
        });
        // The credential-scoped proxy substitutes the token server-side; ours must never travel in the request.
        expect(JSON.stringify(proxied)).not.toContain("management-secret");
        // Grok is not merely unmapped — it is never asked.
        expect(proxied.some((call) => call[`auth_index`] === "grok-index")).toBe(false);
        expect(accounts.grok[0]).not.toHaveProperty("usage");
    });

    /* `accounts` is the routed-turn credential gate. It answers from the store and SCHEDULES the pull, so the
     * upstream round-trip can never land on a turn's startup path — the guarantee the earlier split into a
     * second "with usage" method existed to provide, now held by the one method everything calls. */
    test("answers from the store and refreshes in the background rather than awaiting upstream", async () => {
        const calls: { url: string; body?: Record<string, unknown> }[] = [];
        const { store, snapshots } = memoryStore();
        const client = createCliProxyClient({
            managementUrl: "http://cliproxy.test",
            token: "management-secret",
            configPath: "/tmp/config",
            usageStore: store,
            fetchFn: cliProxyFetch(calls),
        });

        // Cold store: the rows come back at once, unmeasured, and nothing was awaited upstream.
        const first = await client.accounts();
        expect(first.codex[0]).not.toHaveProperty("usage");
        expect(calls.filter((call) => call.url.endsWith("/api-call"))).toHaveLength(0);

        // The sweep it scheduled lands on its own, and the next read is drawn from what it recorded.
        await vi.waitFor(() => expect(Object.keys(snapshots)).toHaveLength(2));
        expect((await client.accounts()).codex[0]).toHaveProperty("usage");
    });

    /* WHEN A SPENT PROVIDER REOPENS — the question a routed 429 leaves unanswered, because CLIProxyAPI walks
     * its whole credential set and reports only the last word on it ("All credentials … are cooling down"). The
     * per-account "Resets in 138h26m8s" is spent inside that walk. These snapshots are the only place the
     * instant survives, so the lookup is pinned on both the ordering and the abstention. */
    const geminiFiles = (windows: Record<string, { utilization: number; resetsAt?: number }>) =>
        (async (input: string | URL): Promise<Response> =>
            String(input).endsWith("/auth-files")
                ? Response.json({
                      files: Object.keys(windows).map((name) => ({ name, provider: "antigravity", auth_index: name })),
                  })
                : Response.json({ status_code: 500 })) as typeof fetch;

    // Exhausted only, and the earliest of them: any ONE account reopening unblocks the turn, so the soonest is
    // the answer. An account with headroom left contributes nothing — it did not refuse.
    test("reports the earliest reset among a provider's exhausted accounts", async () => {
        const { store } = memoryStore();
        const windows = {
            "spent-late.json": { utilization: 100, resetsAt: 3_000 },
            "spent-early.json": { utilization: 100, resetsAt: 2_000 },
            "has-room.json": { utilization: 40, resetsAt: 1_000 },
        };
        for (const [name, window] of Object.entries(windows)) {
            await store.record(`gemini:${name}`, { windows: [{ kind: "google:3p-weekly", ...window }], measuredAt: 0 });
        }
        const client = createCliProxyClient({
            managementUrl: "http://cliproxy.test",
            token: "management-secret",
            configPath: "/tmp/config",
            usageStore: store,
            fetchFn: geminiFiles(windows),
        });

        await expect(client.reopensAt("gemini")).resolves.toBe(2_000);
        // Another provider's accounts are not this provider's headroom, however spent they are.
        await expect(client.reopensAt("codex")).resolves.toBeUndefined();
    });

    // Nothing measured ⇒ no claim. The caller emits a limit with no reset rather than an invented instant.
    test("reports no reset when nothing on file is exhausted", async () => {
        const { store } = memoryStore();
        const windows = { "has-room.json": { utilization: 40, resetsAt: 1_000 } };
        await store.record("gemini:has-room.json", { windows: [{ kind: "google:3p-weekly", utilization: 40, resetsAt: 1_000 }], measuredAt: 0 });
        const client = createCliProxyClient({
            managementUrl: "http://cliproxy.test",
            token: "management-secret",
            configPath: "/tmp/config",
            usageStore: store,
            fetchFn: geminiFiles(windows),
        });

        await expect(client.reopensAt("gemini")).resolves.toBeUndefined();
    });

    // Dropping an account drops its snapshot with it: leaving one behind would hand its headroom to whatever
    // account is next given the same auth-file name.
    test("clears an account's snapshot when it is disconnected", async () => {
        const calls: { url: string; body?: Record<string, unknown> }[] = [];
        const { store, snapshots } = memoryStore();
        const client = createCliProxyClient({
            managementUrl: "http://cliproxy.test",
            token: "management-secret",
            configPath: "/tmp/config",
            usageStore: store,
            fetchFn: cliProxyFetch(calls),
        });

        await client.refreshUsage();
        expect(snapshots).toHaveProperty("gemini:google-a.json");

        await client.disconnect("gemini", "google-a.json");
        expect(snapshots).not.toHaveProperty("gemini:google-a.json");
    });
});
