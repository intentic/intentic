import { z } from "zod";
import { createGoogleModelAvailabilityReader } from "../google-model-availability.js";
import { createCliProxyClient } from "../translator.js";

const MANAGEMENT_URL = "http://cliproxy.test/v0/management";

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};

// One disposable clock/deadline seam, without globally mocking timers or modules.
const manualClock = () => {
    let now = 0;
    let nextId = 0;
    const timers = new Map<number, { at: number; controller: AbortController }>();
    return {
        now: () => now,
        deadline: (ms: number) => {
            const id = nextId++;
            const controller = new AbortController();
            timers.set(id, { at: now + ms, controller });
            return { signal: controller.signal, dispose: () => timers.delete(id) };
        },
        advance: (ms: number) => {
            now += ms;
            for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
                if (timer.at <= now) {
                    timers.delete(id);
                    timer.controller.abort();
                }
            }
        },
        pending: () => timers.size,
    };
};

const google = (name: string, overrides: Record<string, unknown> = {}) => ({
    name: `${name}.json`,
    provider: "antigravity",
    auth_index: `${name}-handle`,
    project_id: `${name}-project`,
    ...overrides,
});

const apiResponse = (payload: unknown, statusCode = 200): Response => Response.json({ status_code: statusCode, body: JSON.stringify(payload) });

type ManagementCall = {
    readonly url: string;
    readonly method: string;
    readonly headers: Headers;
    readonly body: string | undefined;
    readonly signal: AbortSignal | undefined;
};
type ResponsePlan = (call: ManagementCall) => Response | Promise<Response>;
interface ManagementState {
    inventory: unknown;
    inventoryStatus: number;
    inventoryRead: ResponsePlan | undefined;
    metadata: unknown;
}
const ApiRequestSchema = z.object({ auth_index: z.string() });
const RequestBodySchema = z.string().optional().catch(undefined);

const authIndexOf = (call: ManagementCall): string => ApiRequestSchema.parse(JSON.parse(call.body ?? "{}")).auth_index;

// The only HTTP fake in the suite: all requests terminate here, including CliProxyClient integration.
const management = (
    files: readonly unknown[],
    metadata: unknown = { models: { "gemini-3.1-pro": {} } },
    timing: Pick<Parameters<typeof createGoogleModelAvailabilityReader>[0], "requestTimeoutMs" | "sweepTimeoutMs"> = {},
) => {
    const clock = manualClock();
    const calls: ManagementCall[] = [];
    const plans = new Map<string, ResponsePlan>();
    const state: ManagementState = {
        inventory: { files },
        inventoryStatus: 200,
        inventoryRead: undefined,
        metadata,
    };
    const fetchFn = Object.assign(
        async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            const call: ManagementCall = {
                url: String(input),
                method: init?.method ?? "GET",
                headers: new Headers(init?.headers),
                body: RequestBodySchema.parse(init?.body),
                signal: init?.signal ?? undefined,
            };
            calls.push(call);
            if (call.url === `${MANAGEMENT_URL}/auth-files` && call.method === "GET") {
                return state.inventoryRead === undefined
                    ? Response.json(state.inventory, { status: state.inventoryStatus })
                    : state.inventoryRead(call);
            }
            if (call.url === `${MANAGEMENT_URL}/api-call` && call.method === "POST") {
                return plans.get(authIndexOf(call))?.(call) ?? apiResponse(state.metadata);
            }
            throw new Error(`Unexpected management request: ${call.method} ${call.url}`);
        },
        { preconnect: () => undefined },
    );
    const read = createGoogleModelAvailabilityReader({
        managementUrl: MANAGEMENT_URL,
        token: "local-test-token",
        fetchFn,
        now: clock.now,
        deadline: clock.deadline,
        requestTimeoutMs: 5,
        sweepTimeoutMs: 15,
        ...timing,
    });
    return { read, calls, plans, state, clock, fetchFn, requests: (path: string) => calls.filter((call) => call.url === `${MANAGEMENT_URL}${path}`) };
};

const stalledBody = () => {
    const started = deferred<void>();
    const canceled = deferred<void>();
    let cancelCount = 0;
    const stream = new ReadableStream<Uint8Array>(
        {
            pull: () => started.resolve(undefined),
            cancel: () => {
                cancelCount += 1;
                canceled.resolve(undefined);
            },
        },
        { highWaterMark: 0 },
    );
    return { response: new Response(stream), started: started.promise, canceled: canceled.promise, stream, cancelCount: () => cancelCount };
};

describe("Google model availability (offline)", () => {
    test("intersects literal IDs across object and explicit array entries, preserving case, prefixes and suffixes", async () => {
        const h = management([google("a"), google("b")], {
            models: {
                "gemini-3.1-pro-preview": {},
                "Gemini-3.1-Pro": {},
                "gemini-5.5": {},
                "models/gemini-3.1-pro": {},
                "gemini-3.1-pro": {},
                Shared: {},
                " literal ": {},
            },
        });
        h.plans.set("b-handle", () =>
            apiResponse({
                models: [
                    { modelId: "Shared" },
                    { id: "gemini-3.1-pro", displayName: "gemini-5.5" },
                    { name: "models/gemini-3.1-pro" },
                    { id: " literal " },
                    { id: "Shared" },
                    { id: "gemini-3.1-pro-preview-thinking" },
                ],
            }),
        );
        await expect(h.read()).resolves.toEqual({
            state: "verified",
            accounts: 2,
            models: [" literal ", "Shared", "gemini-3.1-pro", "models/gemini-3.1-pro"],
        });
        expect(h.clock.pending()).toBe(0);
    });

    test("31 enabled accounts disprove the static 5.5 ID, then publish later support only after the 60-second TTL", async () => {
        const h = management(
            Array.from({ length: 31 }, (_, index) => google(`account-${index}`)),
            {
                models: { "gemini-3.1-pro": {}, "gemini-3.1-flash": {} },
            },
        );
        const before = { state: "verified", accounts: 31, models: ["gemini-3.1-flash", "gemini-3.1-pro"] } as const;
        await expect(h.read()).resolves.toEqual(before);
        expect(h.requests("/api-call").length).toBe(31);
        h.state.metadata = { models: { "gemini-5.5": {}, "gemini-3.1-pro": {}, "gemini-3.1-flash": {} } };
        h.clock.advance(59_999);
        await expect(h.read()).resolves.toEqual(before);
        expect(h.requests("/auth-files").length).toBe(2);
        expect(h.requests("/api-call").length).toBe(31);
        h.clock.advance(1);
        await expect(h.read()).resolves.toEqual({
            state: "verified",
            accounts: 31,
            models: ["gemini-3.1-flash", "gemini-3.1-pro", "gemini-5.5"],
        });
        expect(h.requests("/auth-files").length).toBe(3);
        expect(h.requests("/api-call").length).toBe(62);
    });

    test.each([
        ["object", {}],
        ["array", []],
    ] as const)("an explicitly empty models %s is a verified empty set", async (_label, models) => {
        const h = management([google("a"), google("b")], { models });
        h.plans.set("b-handle", () => apiResponse({ models: { "gemini-5.5": {} } }));
        await expect(h.read()).resolves.toEqual({ state: "verified", accounts: 2, models: [] });
    });

    const malformed: readonly (readonly [string, unknown])[] = [
        ["missing models", {}],
        ["null payload", null],
        ["array payload", []],
        ["null models", { models: null }],
        ["scalar models", { models: "gemini-5.5" }],
        ["blank object ID", { models: { " ": {} } }],
        ["malformed object entry", { models: { "gemini-5.5": null } }],
        ["scalar array entry", { models: ["gemini-5.5"] }],
        ["display-only array entry", { models: [{ displayName: "gemini-5.5" }] }],
        ["missing array ID", { models: [{ id: "gemini-3.1-pro" }, {}] }],
        ["null array entry", { models: [{ id: "gemini-3.1-pro" }, null] }],
        ["blank array ID", { models: [{ id: " " }] }],
        ["numeric array ID", { models: [{ id: 55 }] }],
        ["malformed declared ID", { models: [{ id: null, name: "gemini-5.5" }] }],
    ];
    test.each(malformed)("%s is unknown for that account, never a complete negative", async (_label, payload) => {
        const h = management([google("a"), google("b")], { models: { "gemini-5.5": {} } });
        h.plans.set("b-handle", () => apiResponse(payload));
        await expect(h.read()).resolves.toEqual({ state: "incomplete", accounts: 2, verified: 1, models: ["gemini-5.5"] });
        expect(h.clock.pending()).toBe(0);
    });

    test.each([
        ["outer HTTP failure", () => new Response("unavailable", { status: 503 })],
        ["inner HTTP failure", () => apiResponse({ models: { "gemini-5.5": {} } }, 403)],
        ["missing inner status", () => Response.json({ body: '{"models":{}}' })],
        ["malformed inner status", () => Response.json({ status_code: "200", body: '{"models":{}}' })],
        ["fractional inner status", () => Response.json({ status_code: 200.5, body: '{"models":{}}' })],
        ["null inner body", () => Response.json({ status_code: 200, body: null })],
        ["malformed inner JSON", () => Response.json({ status_code: 200, body: "not JSON" })],
        ["malformed outer JSON", () => new Response("not JSON")],
        ["transport failure", () => Promise.reject(new Error("offline"))],
    ] as const)("%s does not produce a verified empty list", async (_label, response) => {
        const h = management([google("a")]);
        h.plans.set("a-handle", response);
        await expect(h.read()).resolves.toEqual({ state: "incomplete", accounts: 1, verified: 0, models: [] });
        expect(h.clock.pending()).toBe(0);
    });

    test.each([
        ["project_id", undefined],
        ["project_id", ""],
        ["project_id", "   "],
        ["project_id", 1],
        ["auth_index", undefined],
        ["auth_index", ""],
        ["auth_index", "   "],
        ["auth_index", null],
    ] as const)("missing/blank/malformed %s keeps the account in the incomplete pool", async (field, value) => {
        const h = management([google("good"), google("unreadable", { [field]: value })]);
        const inventoryBefore = JSON.stringify(h.state.inventory);
        await expect(h.read()).resolves.toEqual({ state: "incomplete", accounts: 2, verified: 1, models: ["gemini-3.1-pro"] });
        expect(h.requests("/api-call").map(authIndexOf)).toEqual(["good-handle"]);
        expect(JSON.stringify(h.state.inventory)).toBe(inventoryBefore);
    });

    test("only antigravity rows participate, disabled rows do not, and cooling/error rows still narrow the intersection", async () => {
        const h = management(
            [
                google("active"),
                google("disabled", { disabled: true, project_id: undefined }),
                google("cooling", { unavailable: true, status: "error", status_message: "quota", next_retry_after: "2099-01-01T00:00:00Z" }),
                google("not-antigravity", { provider: "gemini" }),
                google("codex", { provider: "codex" }),
            ],
            { models: { shared: {}, "gemini-5.5": {} } },
        );
        h.plans.set("cooling-handle", () => apiResponse({ models: { shared: {} } }));
        await expect(h.read()).resolves.toEqual({ state: "verified", accounts: 2, models: ["shared"] });
        expect(h.requests("/api-call").map(authIndexOf).sort()).toEqual(["active-handle", "cooling-handle"]);
    });

    test("no enabled Google accounts is verified zero inventory, not model-entitlement proof", async () => {
        const h = management([google("disabled", { disabled: true }), google("other", { provider: "codex" })]);
        await expect(h.read()).resolves.toEqual({ state: "verified", accounts: 0, models: [] });
        expect(h.requests("/api-call").length).toBe(0);
        h.state.inventory = { files: [] };
        await expect(h.read()).resolves.toEqual({ state: "verified", accounts: 0, models: [] });
        expect(h.requests("/auth-files").length).toBe(2);
    });

    test.each([{}, null, { files: null }, { files: "not an inventory" }, { files: [null] }, { files: [{}] }])(
        "a malformed live inventory %p is unknown, not verified zero accounts",
        async (inventory) => {
            const h = management([]);
            h.state.inventory = inventory;
            await expect(h.read()).resolves.toEqual({ state: "unknown" });
            expect(h.requests("/api-call").length).toBe(0);
        },
    );

    test("a failed live inventory cannot reuse a cached proof or silently fall back to disk", async () => {
        const h = management([google("a")]);
        await expect(h.read()).resolves.toEqual({ state: "verified", accounts: 1, models: ["gemini-3.1-pro"] });
        h.state.inventoryStatus = 401;
        await expect(h.read()).resolves.toEqual({ state: "unknown" });
        expect(h.requests("/api-call").length).toBe(1);
        h.state.inventoryStatus = 200;
        h.state.metadata = { models: { "gemini-5.5": {} } };
        await expect(h.read()).resolves.toEqual({ state: "verified", accounts: 1, models: ["gemini-5.5"] });
        expect(h.requests("/api-call").length).toBe(2);
    });

    test("add/remove/disable/re-enable invalidates before TTL and reads the new complete enabled pool", async () => {
        const a = google("a");
        const b = google("b");
        const h = management([a], { models: { shared: {}, "a-only": {} } });
        h.plans.set("b-handle", () => apiResponse({ models: { shared: {}, "b-only": {} } }));
        await expect(h.read()).resolves.toEqual({ state: "verified", accounts: 1, models: ["a-only", "shared"] });
        h.state.inventory = { files: [a, b] };
        await expect(h.read()).resolves.toEqual({ state: "verified", accounts: 2, models: ["shared"] });
        h.state.inventory = { files: [b] };
        await expect(h.read()).resolves.toEqual({ state: "verified", accounts: 1, models: ["b-only", "shared"] });
        h.state.inventory = { files: [google("b", { disabled: true })] };
        await expect(h.read()).resolves.toEqual({ state: "verified", accounts: 0, models: [] });
        h.state.inventory = { files: [b] };
        await expect(h.read()).resolves.toEqual({ state: "verified", accounts: 1, models: ["b-only", "shared"] });
        expect(h.requests("/auth-files").length).toBe(5);
        expect(h.requests("/api-call").map(authIndexOf).sort()).toEqual(["a-handle", "a-handle", "b-handle", "b-handle", "b-handle"]);
    });

    test.each([
        ["project_id", "different-project"],
        ["auth_index", "different-handle"],
        ["name", "reconnected.json"],
        ["created_at", "2026-10-03T12:00:00Z"],
        ["updated_at", "2026-10-03T12:00:00Z"],
        ["modtime", "2026-10-03T12:00:00Z"],
        ["last_refresh", "2026-10-03T12:00:00Z"],
    ] as const)("credential/project/reconnect change in %s invalidates a fresh proof", async (field, value) => {
        const h = management([google("a")]);
        await expect(h.read()).resolves.toEqual({ state: "verified", accounts: 1, models: ["gemini-3.1-pro"] });
        h.state.inventory = { files: [google("a", { [field]: value })] };
        h.state.metadata = { models: { "gemini-5.5": {} } };
        await expect(h.read()).resolves.toEqual({ state: "verified", accounts: 1, models: ["gemini-5.5"] });
        expect(h.requests("/api-call").length).toBe(2);
    });

    test("inventory order and temporary verdict changes preserve the fingerprint without shrinking the pool", async () => {
        const h = management([google("a"), google("b")]);
        const proof = { state: "verified", accounts: 2, models: ["gemini-3.1-pro"] } as const;
        await expect(h.read()).resolves.toEqual(proof);
        h.state.inventory = {
            files: [
                google("b", { unavailable: true, status: "error", status_message: "cooling", next_retry_after: "2099-01-01T00:00:00Z" }),
                google("a", { unavailable: true, status: "cooldown" }),
            ],
        };
        h.state.metadata = { models: {} };
        await expect(h.read()).resolves.toEqual(proof);
        expect(h.requests("/auth-files").length).toBe(2);
        expect(h.requests("/api-call").length).toBe(2);
    });

    test("an expired unsuccessful refresh returns current partial evidence, never the stale verified intersection", async () => {
        const h = management([google("a"), google("b")], { models: { old: {} } });
        await expect(h.read()).resolves.toEqual({ state: "verified", accounts: 2, models: ["old"] });
        h.clock.advance(60_000);
        h.state.metadata = { models: { current: {} } };
        h.plans.set("b-handle", () => apiResponse({ models: { old: {} } }, 500));
        await expect(h.read()).resolves.toEqual({ state: "incomplete", accounts: 2, verified: 1, models: ["current"] });
        h.clock.advance(60_000);
        h.plans.set("a-handle", () => apiResponse({ models: { old: {} } }, 500));
        await expect(h.read()).resolves.toEqual({ state: "incomplete", accounts: 2, verified: 0, models: [] });
        h.plans.clear();
        await expect(h.read()).resolves.toEqual({ state: "verified", accounts: 2, models: ["current"] });
    });

    test("partial verified evidence has the same TTL and is retried once expired", async () => {
        const h = management([google("a"), google("b")]);
        h.plans.set("b-handle", () => apiResponse({}, 500));
        const partial = { state: "incomplete", accounts: 2, verified: 1, models: ["gemini-3.1-pro"] } as const;
        await expect(h.read()).resolves.toEqual(partial);
        h.plans.clear();
        await expect(h.read()).resolves.toEqual(partial);
        expect(h.requests("/api-call").length).toBe(2);
        h.clock.advance(60_000);
        await expect(h.read()).resolves.toEqual({ state: "verified", accounts: 2, models: ["gemini-3.1-pro"] });
        expect(h.requests("/api-call").length).toBe(4);
    });

    test("concurrent callers share the entire inventory fetch and metadata sweep, including the same promise", async () => {
        const h = management([google("a")]);
        const inventory = deferred<Response>();
        const inventoryStarted = deferred<void>();
        const metadata = deferred<Response>();
        const metadataStarted = deferred<void>();
        h.state.inventoryRead = () => {
            inventoryStarted.resolve(undefined);
            return inventory.promise;
        };
        h.plans.set("a-handle", () => {
            metadataStarted.resolve(undefined);
            return metadata.promise;
        });
        const first = h.read();
        const second = h.read();
        expect(second).toBe(first);
        await inventoryStarted.promise;
        expect(h.requests("/auth-files").length).toBe(1);
        inventory.resolve(Response.json(h.state.inventory));
        await metadataStarted.promise;
        const third = h.read();
        expect(third).toBe(first);
        expect(h.requests("/auth-files").length).toBe(1);
        expect(h.requests("/api-call").length).toBe(1);
        metadata.resolve(apiResponse(h.state.metadata));
        const proof = { state: "verified", accounts: 1, models: ["gemini-3.1-pro"] } as const;
        await expect(Promise.all([first, second, third])).resolves.toEqual([proof, proof, proof]);
        h.state.inventoryRead = undefined;
        await expect(h.read()).resolves.toEqual(proof);
        expect(h.requests("/auth-files").length).toBe(2);
        expect(h.requests("/api-call").length).toBe(1);
        expect(h.clock.pending()).toBe(0);
    });

    test("at most three metadata requests are active across the sweep", async () => {
        const h = management(
            Array.from({ length: 7 }, (_, index) => google(`account-${index}`)),
            { models: { shared: {} } },
        );
        const starts = Array.from({ length: 7 }, () => deferred<void>());
        const waiting: (() => void)[] = [];
        let active = 0;
        let peak = 0;
        for (let index = 0; index < 7; index += 1) {
            h.plans.set(`account-${index}-handle`, () => {
                const response = deferred<Response>();
                active += 1;
                peak = Math.max(peak, active);
                starts[h.requests("/api-call").length - 1]?.resolve(undefined);
                waiting.push(() => response.resolve(apiResponse(h.state.metadata)));
                return response.promise.finally(() => {
                    active -= 1;
                });
            });
        }
        const read = h.read();
        await starts[2]?.promise;
        expect(h.requests("/api-call").length).toBe(3);
        expect(active).toBe(3);
        for (let index = 3; index < 7; index += 1) {
            const release = waiting.shift();
            if (release === undefined) {
                throw new Error("Expected an active metadata request");
            }
            release();
            await starts[index]?.promise;
            expect(active).toBe(3);
        }
        for (const release of waiting) {
            release();
        }
        await expect(read).resolves.toEqual({ state: "verified", accounts: 7, models: ["shared"] });
        expect(peak).toBe(3);
        expect(active).toBe(0);
        expect(h.requests("/api-call").length).toBe(7);
        expect(h.clock.pending()).toBe(0);
    });

    test("a stalled inventory fetch is bounded even when fetch ignores its abort signal", async () => {
        const h = management([google("a")]);
        const started = deferred<ManagementCall>();
        h.state.inventoryRead = (call) => {
            started.resolve(call);
            return deferred<Response>().promise;
        };
        const read = h.read();
        const call = await started.promise;
        h.clock.advance(5);
        await expect(read).resolves.toEqual({ state: "unknown" });
        expect(call.signal?.aborted).toBe(true);
        expect(h.requests("/api-call").length).toBe(0);
        expect(h.clock.pending()).toBe(0);
    });

    test("a stalled inventory body is canceled as well as bounded", async () => {
        const h = management([google("a")]);
        const body = stalledBody();
        h.state.inventoryRead = () => body.response;
        const read = h.read();
        await body.started;
        h.clock.advance(5);
        await expect(read).resolves.toEqual({ state: "unknown" });
        await body.canceled;
        expect(body.cancelCount()).toBe(1);
        expect(body.stream.locked).toBe(false);
        expect(h.clock.pending()).toBe(0);
    });

    test("a stalled metadata body is canceled and remains unknown for its enabled account", async () => {
        const h = management([google("a")]);
        const body = stalledBody();
        h.plans.set("a-handle", () => body.response);
        const read = h.read();
        await body.started;
        h.clock.advance(5);
        await expect(read).resolves.toEqual({ state: "incomplete", accounts: 1, verified: 0, models: [] });
        await body.canceled;
        expect(body.cancelCount()).toBe(1);
        expect(body.stream.locked).toBe(false);
        expect(h.requests("/api-call")[0]?.signal?.aborted).toBe(true);
        expect(h.clock.pending()).toBe(0);
    });

    test("the total deadline preserves completed evidence, cancels the three active requests and leaves queued accounts unread", async () => {
        const h = management(
            Array.from({ length: 7 }, (_, index) => google(`account-${index}`)),
            { models: { shared: {} } },
            { requestTimeoutMs: 50 },
        );
        const stalled: ManagementCall[] = [];
        const allWorkersStalled = deferred<void>();
        for (let index = 1; index < 7; index += 1) {
            h.plans.set(`account-${index}-handle`, (call) => {
                stalled.push(call);
                if (stalled.length === 3) {
                    allWorkersStalled.resolve(undefined);
                }
                return deferred<Response>().promise;
            });
        }
        const read = h.read();
        // The fourth request starts only after the first account's body was read and its evidence recorded.
        await allWorkersStalled.promise;
        h.clock.advance(15);
        await expect(read).resolves.toEqual({ state: "incomplete", accounts: 7, verified: 1, models: ["shared"] });
        expect(h.requests("/api-call").length).toBe(4);
        expect(stalled.map((call) => call.signal?.aborted)).toEqual([true, true, true]);
        expect(h.clock.pending()).toBe(0);
    });

    test("the total deadline also bounds the inventory phase", async () => {
        const h = management([google("a")], undefined, { requestTimeoutMs: 50 });
        const started = deferred<ManagementCall>();
        h.state.inventoryRead = (call) => {
            started.resolve(call);
            return deferred<Response>().promise;
        };
        const read = h.read();
        const call = await started.promise;
        h.clock.advance(15);
        await expect(read).resolves.toEqual({ state: "unknown" });
        expect(call.signal?.aborted).toBe(true);
        expect(h.clock.pending()).toBe(0);
    });

    test("a late timed-out response is canceled and cannot overwrite a newer inventory's proof", async () => {
        const h = management([google("a")]);
        const oldResponse = deferred<Response>();
        const started = deferred<ManagementCall>();
        h.plans.set("a-handle", (call) => {
            started.resolve(call);
            return oldResponse.promise;
        });
        const oldRead = h.read();
        const oldCall = await started.promise;
        h.clock.advance(5);
        await expect(oldRead).resolves.toEqual({ state: "incomplete", accounts: 1, verified: 0, models: [] });
        h.state.inventory = { files: [google("b")] };
        h.state.metadata = { models: { newer: {} } };
        await expect(h.read()).resolves.toEqual({ state: "verified", accounts: 1, models: ["newer"] });
        const lateBody = stalledBody();
        oldResponse.resolve(lateBody.response);
        await lateBody.canceled;
        expect(lateBody.cancelCount()).toBe(1);
        expect(oldCall.signal?.aborted).toBe(true);
        await expect(h.read()).resolves.toEqual({ state: "verified", accounts: 1, models: ["newer"] });
        expect(h.requests("/auth-files").length).toBe(3);
        expect(h.requests("/api-call").length).toBe(2);
        expect(h.clock.pending()).toBe(0);
    });

    test("uses only local management Bearer auth and the server-side OAuth placeholder, with no account mutations", async () => {
        const h = management([google("a", { auth_index: " exact-handle ", project_id: " exact-project " })]);
        await expect(h.read()).resolves.toEqual({ state: "verified", accounts: 1, models: ["gemini-3.1-pro"] });
        expect(h.calls.map((call) => [call.method, call.url])).toEqual([
            ["GET", `${MANAGEMENT_URL}/auth-files`],
            ["POST", `${MANAGEMENT_URL}/api-call`],
        ]);
        expect(h.calls.map((call) => call.headers.get("authorization"))).toEqual(["Bearer local-test-token", "Bearer local-test-token"]);
        const proxied = h.requests("/api-call")[0];
        expect(proxied?.headers.get("content-type")).toBe("application/json");
        expect(JSON.parse(proxied?.body ?? "{}")).toEqual({
            auth_index: " exact-handle ",
            method: "POST",
            url: "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
            header: {
                Authorization: "Bearer $TOKEN$",
                "Content-Type": "application/json",
                "User-Agent": "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)",
            },
            data: JSON.stringify({ project: " exact-project " }),
        });
    });

    test("CliProxyClient constructs one reader with its existing URL, token and injected fetch", async () => {
        const h = management([google("a")]);
        const client = createCliProxyClient({
            managementUrl: MANAGEMENT_URL,
            token: "client-test-token",
            fetchFn: h.fetchFn,
            configPath: "/unused/config.yaml",
            authDir: "/unused/auth",
            usageStore: {
                read: async () => {
                    throw new Error("Availability must not read usage or disk inventory");
                },
            },
        });
        const first = client.googleModelAvailability();
        const second = client.googleModelAvailability();
        expect(second).toBe(first);
        const proof = { state: "verified", accounts: 1, models: ["gemini-3.1-pro"] } as const;
        await expect(Promise.all([first, second])).resolves.toEqual([proof, proof]);
        await expect(client.googleModelAvailability()).resolves.toEqual(proof);
        expect(h.requests("/auth-files").length).toBe(2);
        expect(h.requests("/api-call").length).toBe(1);
        expect(h.calls.map((call) => call.headers.get("authorization"))).toEqual([
            "Bearer client-test-token",
            "Bearer client-test-token",
            "Bearer client-test-token",
        ]);
    });
});
