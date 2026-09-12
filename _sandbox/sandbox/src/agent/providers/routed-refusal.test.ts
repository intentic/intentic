import { expect, test } from "vitest";
import { probeRoutedEndpoint, routedRefusal, routedEndpointOf, transientUpstream } from "./routed-refusal.js";

// Pins the distinction the module exists for: a 5xx to ride out vs. one to never wait for, both arriving from the SDK
// as `server_error` with no body. Strings below are verbatim from this sandbox's translator.

const AUTH_UNAVAILABLE = JSON.stringify({
    type: "error",
    error: {
        type: "api_error",
        message:
            "auth_unavailable: no auth available (providers=kimi, model=kimi-k2.7-code-highspeed; last upstream error: " +
            "authentication_error: Your current subscription does not have access to kimi-for-coding-highspeed. " +
            "Upgrade to higher-tier Kimi Code plans.)",
    },
});

// Before the proxy files the credential away: the upstream's own 401, wrapped once.
const UPSTREAM_401 = JSON.stringify({
    type: "error",
    error: {
        type: "authentication_error",
        message: "Your current subscription does not have access to kimi-for-coding-highspeed. Upgrade to higher-tier Kimi Code plans.",
    },
});

test("a plan that does not cover the model is a refusal, quoted in the vendor's own words", () => {
    const refusal = routedRefusal(AUTH_UNAVAILABLE);
    expect(refusal).toBe("Your current subscription does not have access to kimi-for-coding-highspeed. Upgrade to higher-tier Kimi Code plans.");
});

test("the same refusal before the proxy has filed the credential away reads the same", () => {
    expect(routedRefusal(UPSTREAM_401)).toBe(
        "Your current subscription does not have access to kimi-for-coding-highspeed. Upgrade to higher-tier Kimi Code plans.",
    );
});

test.each([
    ["overloaded", JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })],
    ["a cooling credential", JSON.stringify({ error: { code: "model_cooldown", message: "All credentials for model kimi-k3 are cooling down" } })],
    ["a bare gateway error", "502 Bad Gateway"],
    ["an empty body", ""],
])("%s keeps riding the retry ladder", (_case, body) => {
    expect(routedRefusal(body)).toBeUndefined();
});

test("an unparseable body that names a refusal is quoted as it stands", () => {
    expect(routedRefusal("auth_unavailable: no auth available")).toBe("auth_unavailable: no auth available");
});

// The same envelope the plan refusal above arrives in, wrapped around a failure that never reached the model. All
// three are verbatim from this sandbox's daemon log; the credential served other turns minutes either side of them.
const DNS_STALL =
    "unexpected status 503 Service Unavailable: auth_unavailable: no auth available (providers=codex, model=gpt-6-astra; " +
    'last upstream error: Post "https://chatgpt.com/backend-api/codex/responses": utls: dial upstream: dial tcp: ' +
    "lookup chatgpt.com on 127.0.0.11:53: read udp 127.0.0.1:36274->127.0.0.11:53: i/o timeout), url: http://127.0.0.1:8789/v1/responses";

const REFUSED_DIAL =
    "unexpected status 503 Service Unavailable: auth_unavailable: no auth available (providers=codex, model=gpt-6-astra; " +
    'last upstream error: Post "https://chatgpt.com/backend-api/codex/responses": utls: dial upstream: ' +
    "dial tcp 104.18.32.47:443: connect: connection refused), url: http://127.0.0.1:8789/v1/responses";

const NO_CAPACITY = JSON.stringify({
    type: "error",
    error: {
        type: "api_error",
        message:
            "auth_unavailable: no auth available (providers=antigravity, model=claude-opus-4-6-thinking; last upstream error: " +
            '{"error":{"code":503,"message":"No capacity available for model claude-opus-4-6-thinking on the server","status":"UNAVAILABLE"}})',
    },
});

test.each([
    ["a stalled name lookup", DNS_STALL],
    ["a refused dial", REFUSED_DIAL],
    ["an upstream with no capacity", NO_CAPACITY],
])("%s wears the refusal envelope but keeps riding the retry ladder", (_case, body) => {
    expect(transientUpstream(body)).toBe(true);
    expect(routedRefusal(body)).toBeUndefined();
});

test("a plan that does not cover the model is not transient, however often it is asked", () => {
    expect(transientUpstream(AUTH_UNAVAILABLE)).toBe(false);
    expect(transientUpstream(UPSTREAM_401)).toBe(false);
    // The envelope every one of these 503s carries: read alone it would make a plan refusal look like an outage.
    expect(transientUpstream("unexpected status 503 Service Unavailable: auth_unavailable: no auth available")).toBe(false);
});

test("an endpoint is only routed when all three of its parts are there", () => {
    expect(routedEndpointOf({ baseUrl: "http://127.0.0.1:8789", authToken: "t", model: "kimi-k3" })).toEqual({
        baseUrl: "http://127.0.0.1:8789",
        authToken: "t",
        model: "kimi-k3",
    });
    // A native Claude turn: no endpoint, nothing to ask.
    expect(routedEndpointOf({ oauthToken: "x" } as { baseUrl?: string })).toBeUndefined();
    expect(routedEndpointOf({ baseUrl: "http://127.0.0.1:8789", authToken: "t" })).toBeUndefined();
});

test("the probe asks the endpoint the smallest question there is, and reports what it refuses", async () => {
    let asked: { url: string; body: unknown } | undefined;
    const refusal = await probeRoutedEndpoint(
        { baseUrl: "http://127.0.0.1:8789/", authToken: "local-bearer", model: "kimi-k2.7-code-highspeed" },
        {
            fetchFn: (async (url: string, init: { body: string }) => {
                asked = { url, body: JSON.parse(init.body) };
                return { ok: false, text: () => Promise.resolve(AUTH_UNAVAILABLE) };
            }) as unknown as typeof fetch,
        },
    );
    expect(refusal).toContain("does not have access");
    expect(asked?.url).toBe("http://127.0.0.1:8789/v1/messages");
    expect(asked?.body).toMatchObject({ model: "kimi-k2.7-code-highspeed", max_tokens: 1 });
});

test("an endpoint that answers is not a refusal", async () => {
    const refusal = await probeRoutedEndpoint(
        { baseUrl: "http://127.0.0.1:8789", authToken: "t", model: "kimi-k3" },
        { fetchFn: (() => Promise.resolve({ ok: true, text: () => Promise.resolve("") })) as unknown as typeof fetch },
    );
    expect(refusal).toBeUndefined();
});

test("a probe that cannot reach the endpoint changes nothing", async () => {
    const refusal = await probeRoutedEndpoint(
        { baseUrl: "http://127.0.0.1:8789", authToken: "t", model: "kimi-k3" },
        {
            fetchFn: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
        },
    );
    expect(refusal).toBeUndefined();
});
