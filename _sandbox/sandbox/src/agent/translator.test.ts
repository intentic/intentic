import { type AccountUsage, TranslatorAccountsSchema } from "@intentic/sandbox-contract";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createCliProxyClient, nextRestartDelay, renderConfig, RESTART_DELAY_BASE_MS, RESTART_DELAY_CAP_MS, TRANSLATOR_BINARY_MISSING } from "./translator.js";

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

/* ONE REQUEST MAY NOT COST THE WHOLE FLEET. CLIProxyAPI retries a refusal on the next credential, and its own
 * default (0) means "every auth file you hold" — correct only if a refusal is always about the account it came
 * from. Google's is not: it answers a request it objects to with the same RESOURCE_EXHAUSTED as a spent quota,
 * so one unservable request walked all 31 connected accounts, 44–62 upstream calls, ~60 seconds, every one of
 * them at ~0% utilization.
 *
 * Asserted on the rendered file because that is the only surface this repo owns — the walk happens inside a
 * separate binary that reads it. A missing key is not a neutral omission here: it unmarshals to Go's zero, which
 * is the unbounded walk, which is how this went unnoticed. */
test("bounds how many accounts one request may be retried on", () => {
    const config = renderConfig({ port: 8789, authDir: "/agent-auth/cliproxy", token: "t", compat: "" });

    expect(config).toContain("max-retry-credentials: 5");
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

test("starts Google's redirect login through CLIProxyAPI Antigravity auth URL", async () => {
    const fetchMock = vi.fn(async () =>
        Response.json({ url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=123", state: "state-123", status: "ok" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createCliProxyClient({
        managementUrl: "http://127.0.0.1:8789/v0/management",
        token: "local",
        configPath: "/tmp/config.yaml",
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

test("throws TRANSLATOR_BINARY_MISSING when Google connect fails due to unreachable proxy", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));
    const client = createCliProxyClient({
        managementUrl: "http://127.0.0.1:8789/v0/management",
        token: "local",
        configPath: "/tmp/config.yaml",
        usageStore: memoryStore().store,
    });

    await expect(client.connect("gemini")).rejects.toThrow(TRANSLATOR_BINARY_MISSING);
});

test("completes Google's redirect login via oauth-callback", async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createCliProxyClient({
        managementUrl: "http://127.0.0.1:8789/v0/management",
        token: "local",
        configPath: "/tmp/config.yaml",
        usageStore: memoryStore().store,
    });

    await expect(client.complete({ provider: "gemini", redirectUrl: "http://localhost:51121/oauth-callback?code=abc&state=xyz", state: "xyz" })).resolves.toBeUndefined();
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

    /* WHETHER A SPENT PROVIDER CAN SERVE THIS MODEL, and when it next can — the question a routed 429 leaves
     * unanswered, because CLIProxyAPI balances across its whole credential set and reports only the last word on
     * it ("All credentials … are cooling down"), naming no account and carrying no per-account reset. These
     * snapshots are the only place either survives, so the lookup is pinned on the ordering, the abstention,
     * and — the correction these tests exist for — the POOL the turn's model actually spends. */
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
            usageStore: store,
            fetchFn: filesNamed(provider, names),
        });

    // Exhausted only, and the earliest of them: any ONE account reopening unblocks the turn, so the soonest is
    // the answer.
    test("reports the earliest reset among a provider's exhausted accounts", async () => {
        const { store } = memoryStore();
        const windows = {
            "spent-late.json": { utilization: 100, resetsAt: 3_000 },
            "spent-early.json": { utilization: 100, resetsAt: 2_000 },
        };
        for (const [name, window] of Object.entries(windows)) {
            await store.record(`gemini:${name}`, { windows: [{ kind: "google:3p-weekly", ...window }], measuredAt: 0 });
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

    /* THE POOL THE MODEL SPENDS, which is the correction the rest of this rests on.
     *
     * One Google sign-in meters Gemini separately from the Claude and GPT models, on separate clocks. Reading
     * both as one allowance answered a Claude Opus turn with the GEMINI pool's instant — on a pool that turn
     * never touched — while the pool it WAS spending still had room. Same store, same account, same moment, two
     * models, two different answers. */
    test("answers from the pool the turn's model spends, not from the account's fullest one", async () => {
        const { store } = memoryStore();
        await store.record("gemini:spent-for-gemini.json", {
            windows: [
                { kind: "google:gemini-weekly", utilization: 100, resetsAt: 2_000 },
                { kind: "google:3p-weekly", utilization: 73, resetsAt: 9_000 },
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
        await expect(client.turnLimit("gemini", "claude-opus-4-6-thinking")).resolves.toEqual({
            pool: "Claude and GPT models",
            spent: 0,
            withHeadroom: 1,
        });
    });

    /* ONE ACCOUNT WITH ROOM AMONG THIRTY SPENT ONES IS NOT A SPENT PLAN — the translator balances across all of
     * them, so the one with room can serve the turn. No reset is reported for the same reason: the quota is not
     * what refused it, and naming a wall days out over a cooldown that clears in seconds is the lie this
     * replaces. */
    test("reports headroom rather than a reset while any account can still serve the pool", async () => {
        const { store } = memoryStore();
        for (const name of ["spent-1.json", "spent-2.json"]) {
            await store.record(`gemini:${name}`, { windows: [{ kind: "google:3p-weekly", utilization: 100, resetsAt: 2_000 }], measuredAt: 0 });
        }
        await store.record("gemini:has-room.json", { windows: [{ kind: "google:3p-weekly", utilization: 73, resetsAt: 9_000 }], measuredAt: 0 });
        const client = clientOver(store, "antigravity", ["spent-1.json", "spent-2.json", "has-room.json"]);

        await expect(client.turnLimit("gemini", "claude-opus-4-6-thinking")).resolves.toEqual({
            pool: "Claude and GPT models",
            spent: 2,
            withHeadroom: 1,
        });
    });

    // Nothing measured ⇒ no claim, and the two zeroes are how the caller is told so. A bucket the provider has
    // since renamed lands here too, which costs the caller its counts rather than handing it another pool's reset.
    test("counts an account with no reading for this pool in neither tally", async () => {
        const { store } = memoryStore();
        await store.record("gemini:unread.json", { windows: [{ kind: "google:gemini-weekly", utilization: 100, resetsAt: 1_000 }], measuredAt: 0 });
        const client = clientOver(store, "antigravity", ["unread.json", "never-polled.json"]);

        await expect(client.turnLimit("gemini", "claude-opus-4-6-thinking")).resolves.toEqual({
            pool: "Claude and GPT models",
            spent: 0,
            withHeadroom: 0,
        });
    });

    // Codex and Kimi sell one undivided plan, so EVERY window gates every model: a spent 5-hour throttle stops a
    // turn the weekly pool would have allowed, and there is no pool to name in a sentence.
    test("treats an undivided plan's every window as gating, with no pool to name", async () => {
        const { store } = memoryStore();
        await store.record("codex:one.json", {
            windows: [
                { kind: "five_hour", utilization: 100, resetsAt: 1_000 },
                { kind: "seven_day", utilization: 12, resetsAt: 8_000 },
            ],
            measuredAt: 0,
        });
        const client = clientOver(store, "codex", ["one.json"]);

        await expect(client.turnLimit("codex", "gpt-5")).resolves.toEqual({ spent: 1, withHeadroom: 0, reopensAt: 1_000 });
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
