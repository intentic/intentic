import { expect, test } from "vitest";
import { probeRoutedEndpoint, routedRefusal, routedEndpointOf } from "./routed-refusal.js";

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
