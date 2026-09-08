import { type AccountUsage, TranslatorAccountsSchema, type UsageWindow } from "@intentic/sandbox-contract";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createCliProxyClient, renderConfig, TRANSLATOR_BINARY_MISSING } from "./translator.js";

// In-memory account-usage store every client in this file shares; `accounts` reads it on every call.
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

// Asserted on the rendered config, since the retry walk runs inside a separate binary that reads it; a missing key
// unmarshals to Go's zero, i.e. unbounded.
test("bounds how many accounts one request may be retried on", () => {
    const config = renderConfig({ port: 8789, authDir: "/agent-auth/cliproxy", token: "t", compat: "" });

    expect(config).toContain("max-retry-credentials: 5");
});

// Filtered at the proxy's edge since the upstream paths don't all strip it themselves; asserted on the rendered config
// for the same reason as above. `prompt_cache_key` must survive: filtering it would cost the session's warm cache.
test("strips the cache-retention parameter nothing here sends, for every model the proxy serves", () => {
    const config = renderConfig({ port: 8789, authDir: "/agent-auth/cliproxy", token: "t", compat: "" });

    expect(config).toContain(`payload:`);
    expect(config).toContain(`        - "prompt_cache_retention"`);
    expect(config).toContain(`        - name: "*"`);
    expect(config).not.toContain(`- "prompt_cache_key"`);
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
        authDir: "/tmp/does-not-exist-authdir",
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

test("starts Google's redirect login through CLIProxyAPI Antigravity auth URL", async () => {
    const fetchMock = vi.fn(async () =>
        Response.json({ url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=123", state: "state-123", status: "ok" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createCliProxyClient({
        managementUrl: "http://127.0.0.1:8789/v0/management",
        token: "local",
        configPath: "/tmp/config.yaml",
        authDir: "/tmp/does-not-exist-authdir",
        usageStore: memoryStore().store,
    });

    await expect(client.connect("gemini")).resolves.toEqual({
        url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=123",
        code: "",
        state: "state-123",
        flow: "redirect",
    });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8789/v0/management/antigravity-auth-url", {
        headers: { authorization: "Bearer local" },
    });
});

// Builds a client whose proxy never answers, with or without the binary present; the two cases need different advice to
// the user.
const unreachableClient = (binaryPresent: boolean) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));
    return createCliProxyClient({
        managementUrl: "http://127.0.0.1:8789/v0/management",
        token: "local",
        configPath: "/tmp/config.yaml",
        authDir: "/tmp/does-not-exist-authdir",
        usageStore: memoryStore().store,
        binaryPresent: async () => binaryPresent,
    });
};

test("asks for a rebuild when Google connect finds no translator binary in this image", async () => {
    await expect(unreachableClient(false).connect("gemini")).rejects.toThrow(TRANSLATOR_BINARY_MISSING);
});

test("asks the user to wait when the translator is present but not answering yet", async () => {
    const failure = unreachableClient(true).connect("gemini");

    await expect(failure).rejects.toThrow(/starting up/);
    await expect(failure).rejects.not.toThrow(TRANSLATOR_BINARY_MISSING);
});

// The other half — accounts on disk when the proxy is unreachable — lives in translator.integration.test.ts, which
// needs a real auth dir.

test("completes Google's redirect login via oauth-callback", async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createCliProxyClient({
        managementUrl: "http://127.0.0.1:8789/v0/management",
        token: "local",
        configPath: "/tmp/config.yaml",
        authDir: "/tmp/does-not-exist-authdir",
        usageStore: memoryStore().store,
    });

    await expect(
        client.complete({ provider: "gemini", redirectUrl: "http://localhost:51121/oauth-callback?code=abc&state=xyz", state: "xyz" }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8789/v0/management/oauth-callback", {
        method: "POST",
        headers: { authorization: "Bearer local", "content-type": "application/json" },
        body: JSON.stringify({
            provider: "antigravity",
            redirect_url: "http://localhost:51121/oauth-callback?code=abc&state=xyz",
            state: "xyz",
        }),
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
        authDir: "/tmp/does-not-exist-authdir",
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
        authDir: "/tmp/does-not-exist-authdir",
        usageStore: memoryStore().store,
    });

    await expect(client.accounts()).resolves.toEqual({
        codex: [],
        grok: [],
        kimi: [{ name: "kimi-user.json", label: "Kimi User" }],
        gemini: [],
    });
});

// Pins two things about the routed accounts' quota path: rows carry `usage`, and reading them from `accounts` never
// triggers an upstream round-trip.
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
                        // Grok has no readable quota; must never reach the api-call path.
                        { name: "grok-a.json", provider: "xai", email: "grok@example.com", auth_index: "grok-index" },
                        // Benched by the proxy itself, in the shape /auth-files lists it.
                        {
                            name: "kimi-a.json",
                            provider: "kimi",
                            email: "kimi@example.com",
                            auth_index: "kimi-index",
                            unavailable: true,
                            status_message: "quota exceeded",
                            next_retry_after: "2027-01-15T08:10:00Z",
                        },
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
            authDir: "/tmp/does-not-exist-authdir",
            usageStore: store,
            fetchFn: cliProxyFetch(calls),
        });

        // Targets are read directly here, as the headroom service would read them.
        const targets = await client.headroom.targets();
        for (const target of targets) {
            const reading = await target.read();
            // Mirrors the service: no pool read leaves nothing recorded.
            if (reading.windows.length > 0) {
                await store.record(target.key, { windows: [...reading.windows], measuredAt: Date.now() });
            }
        }
        const accounts = await client.accounts();

        expect(() => TranslatorAccountsSchema.parse(accounts)).not.toThrow();
        // Benched, not excluded: Kimi is still a target since the bench is the proxy's, not the plan's.
        expect(targets.map((target) => [target.provider, target.key])).toEqual([
            ["codex", "codex:codex-a.json"],
            ["kimi", "kimi:kimi-a.json"],
            ["gemini", "gemini:google-a.json"],
        ]);
        expect(accounts.codex[0]).toMatchObject({
            name: "codex-a.json",
            label: "chat@example.com",
            usage: { windows: [{ kind: "five_hour", utilization: 41, gates: "all" }] },
        });
        expect(accounts.gemini[0]).toMatchObject({
            name: "google-a.json",
            label: "google@example.com",
            // A group naming neither family is the plan's own allowance and gates everything.
            usage: { windows: [{ kind: "google:weekly", utilization: 70, gates: "all" }] },
        });
        // Namespaced by provider: shared with native accounts; a file name is unique only per provider.
        expect(Object.keys(snapshots).toSorted()).toEqual(["codex:codex-a.json", "gemini:google-a.json"]);

        const proxied = calls.filter((call) => call.url.endsWith("/api-call")).map((call) => call.body!);
        expect(proxied.find((call) => call[`auth_index`] === "codex-index")?.[`header`]).toMatchObject({
            Authorization: "Bearer $TOKEN$",
            "Chatgpt-Account-Id": "chatgpt-account",
        });
        expect(proxied.find((call) => call[`auth_index`] === "google-index")).toMatchObject({
            data: JSON.stringify({ project: "google-project" }),
        });
        // The proxy substitutes the token server-side; ours must never appear in the request.
        expect(JSON.stringify(proxied)).not.toContain("management-secret");
        // Grok is not merely unmapped: it is never asked.
        expect(proxied.some((call) => call[`auth_index`] === "grok-index")).toBe(false);
        expect(accounts.grok[0]).not.toHaveProperty("usage");
    });

    // `accounts` never awaits upstream; the headroom service populates the store on its own triggers instead.
    test("answers from the store rather than awaiting upstream, and carries the proxy's own bench of a credential", async () => {
        const calls: { url: string; body?: Record<string, unknown> }[] = [];
        const { store } = memoryStore();
        const client = createCliProxyClient({
            managementUrl: "http://cliproxy.test",
            token: "management-secret",
            configPath: "/tmp/config",
            authDir: "/tmp/does-not-exist-authdir",
            usageStore: store,
            fetchFn: cliProxyFetch(calls),
        });

        // Store starts cold: rows return unmeasured, nothing asked upstream yet.
        const first = await client.accounts();
        expect(first.codex[0]).not.toHaveProperty("usage");
        expect(calls.filter((call) => call.url.endsWith("/api-call"))).toHaveLength(0);
        // A benched file's row reports the proxy's retry instant, overriding whatever the last reading said.
        expect(first.kimi[0]).toMatchObject({ name: "kimi-a.json", cooling: { until: 1_800_000_600, reason: "quota exceeded" } });
        expect(first.gemini[0]).not.toHaveProperty("cooling");
        await expect(client.turnLimit("kimi", "kimi-k2")).resolves.toEqual({ spent: 1, withHeadroom: 0, reopensAt: 1_800_000_600 });
        // A file the provider holds alone is what a pushed reading can be filed under; a fleet is not.
        await expect(client.sharedUsageKey("codex")).resolves.toBe("codex:codex-a.json");
    });

    // Whether a spent provider can still serve a model, and when it reopens: CLIProxyAPI's own 429 names no account and
    // no per-account reset. Pins the correction: the pool the turn's model actually spends.
    // The gates the Google reader gives its two groups (googleGates), recorded here by hand.
    const GEMINI: Pick<UsageWindow, "label" | "gates"> = { label: "Gemini models", gates: { models: ["gemini"] } };
    const THIRD_PARTY: Pick<UsageWindow, "label" | "gates"> = { label: "Claude and GPT models", gates: { models: ["claude", "gpt"] } };

    const filesNamed = (provider: string, names: readonly string[]) =>
        (async (input: string | URL): Promise<Response> =>
            String(input).endsWith("/auth-files")
                ? Response.json({ files: names.map((name) => ({ name, provider, auth_index: name })) })
                : Response.json({ status_code: 500 })) as typeof fetch;

    const clientOver = (store: ReturnType<typeof memoryStore>["store"], provider: string, names: readonly string[]) =>
        createCliProxyClient({
            managementUrl: "http://cliproxy.test",
            token: "management-secret",
            configPath: "/tmp/config",
            authDir: "/tmp/does-not-exist-authdir",
            usageStore: store,
            fetchFn: filesNamed(provider, names),
        });

    test("reports the earliest reset among a provider's exhausted accounts", async () => {
        const { store } = memoryStore();
        const windows = {
            "spent-late.json": { utilization: 100, resetsAt: 3_000 },
            "spent-early.json": { utilization: 100, resetsAt: 2_000 },
        };
        for (const [name, window] of Object.entries(windows)) {
            await store.record(`gemini:${name}`, { windows: [{ kind: "google:3p-weekly", ...THIRD_PARTY, ...window }], measuredAt: 0 });
        }
        const client = clientOver(store, "antigravity", Object.keys(windows));

        await expect(client.turnLimit("gemini", "claude-opus-4-6-thinking")).resolves.toEqual({
            pool: "Claude and GPT models",
            spent: 2,
            withHeadroom: 0,
            reopensAt: 2_000,
        });
        // Another provider's accounts are not this provider's headroom, however spent they are.
        await expect(client.turnLimit("codex", "gpt-5")).resolves.toEqual({ spent: 0, withHeadroom: 0 });
    });

    // One Google sign-in meters Gemini separately from Claude/GPT models, on separate clocks; a turn reads the pool its
    // own model spends.
    test("answers from the pool the turn's model spends, not from the account's fullest one", async () => {
        const { store } = memoryStore();
        await store.record("gemini:spent-for-gemini.json", {
            windows: [
                { kind: "google:gemini-weekly", ...GEMINI, utilization: 100, resetsAt: 2_000 },
                { kind: "google:3p-weekly", ...THIRD_PARTY, utilization: 73, resetsAt: 9_000 },
            ],
            measuredAt: 0,
        });
        const client = clientOver(store, "antigravity", ["spent-for-gemini.json"]);

        await expect(client.turnLimit("gemini", "gemini-3-pro")).resolves.toEqual({
            pool: "Gemini models",
            spent: 1,
            withHeadroom: 0,
            reopensAt: 2_000,
        });
        // Nothing is out, so there is no pool to name; the reading with room says when it was taken.
        await expect(client.turnLimit("gemini", "claude-opus-4-6-thinking")).resolves.toEqual({ spent: 0, withHeadroom: 1, roomMeasuredAt: 0 });
    });

    // The translator balances across every account, so one with room can still serve the turn among many spent ones.
    test("reports headroom rather than a reset while any account can still serve the pool", async () => {
        const { store } = memoryStore();
        for (const name of ["spent-1.json", "spent-2.json"]) {
            await store.record(`gemini:${name}`, { windows: [{ kind: "google:3p-weekly", ...THIRD_PARTY, utilization: 100, resetsAt: 2_000 }], measuredAt: 0 });
        }
        await store.record("gemini:has-room.json", { windows: [{ kind: "google:3p-weekly", ...THIRD_PARTY, utilization: 73, resetsAt: 9_000 }], measuredAt: 0 });
        const client = clientOver(store, "antigravity", ["spent-1.json", "spent-2.json", "has-room.json"]);

        await expect(client.turnLimit("gemini", "claude-opus-4-6-thinking")).resolves.toEqual({
            pool: "Claude and GPT models",
            spent: 2,
            withHeadroom: 1,
            roomMeasuredAt: 0,
        });
    });

    // An unmeasured or renamed bucket counts as nothing, not another pool's reading.
    test("counts an account with no reading for this pool in neither tally", async () => {
        const { store } = memoryStore();
        await store.record("gemini:unread.json", { windows: [{ kind: "google:gemini-weekly", ...GEMINI, utilization: 100, resetsAt: 1_000 }], measuredAt: 0 });
        const client = clientOver(store, "antigravity", ["unread.json", "never-polled.json"]);

        await expect(client.turnLimit("gemini", "claude-opus-4-6-thinking")).resolves.toEqual({ spent: 0, withHeadroom: 0 });
    });

    test("treats an undivided plan's every window as gating, with no pool to name", async () => {
        const { store } = memoryStore();
        await store.record("codex:one.json", {
            windows: [
                { kind: "five_hour", utilization: 100, resetsAt: 1_000, gates: "all" },
                { kind: "seven_day", utilization: 12, resetsAt: 8_000, gates: "all" },
            ],
            measuredAt: 0,
        });
        const client = clientOver(store, "codex", ["one.json"]);

        await expect(client.turnLimit("codex", "gpt-5")).resolves.toEqual({ spent: 1, withHeadroom: 0, reopensAt: 1_000 });
    });

    test("asks the proxy to drop the account it is told to disconnect", async () => {
        const calls: { url: string; body?: Record<string, unknown> }[] = [];
        const { store } = memoryStore();
        const client = createCliProxyClient({
            managementUrl: "http://cliproxy.test",
            token: "management-secret",
            configPath: "/tmp/config",
            authDir: "/tmp/does-not-exist-authdir",
            usageStore: store,
            fetchFn: cliProxyFetch(calls),
        });

        await client.disconnect("gemini", "google-a.json");
        expect(calls.some((call) => call.url.endsWith("/auth-files?name=google-a.json"))).toBe(true);
    });
});
