import { expect, test } from "vitest";
import { probeRoutedEndpoint, routedRefusal, routedEndpointOf } from "./routed-refusal.js";

/* THE DISTINCTION THIS WHOLE MODULE EXISTS FOR: a 5xx the harness should ride out, against a 5xx it should
 * never wait one second for. Both arrive at the SDK as `server_error` with no body, which is why the body is
 * fetched again here and read as text. The strings below are verbatim from this sandbox's own translator. */

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

// The first call, before the proxy files the credential away: the upstream's own 401, wrapped once.
const UPSTREAM_401 = JSON.stringify({
    type: "error",
    error: {
        type: "authentication_error",
        message: "Your current subscription does not have access to kimi-for-coding-highspeed. Upgrade to higher-tier Kimi Code plans.",
    },
});

test("a plan that does not cover the model is a refusal, quoted in the vendor's own words", () => {
    const refusal = routedRefusal(AUTH_UNAVAILABLE);
    // The tail, from the upstream's own error onwards: the head is the proxy explaining its bookkeeping, and
    // "no auth available (providers=kimi…" is not something to put in front of a person.
    expect(refusal).toBe("Your current subscription does not have access to kimi-for-coding-highspeed. Upgrade to higher-tier Kimi Code plans.");
});

test("the same refusal before the proxy has filed the credential away reads the same", () => {
    expect(routedRefusal(UPSTREAM_401)).toBe(
        "Your current subscription does not have access to kimi-for-coding-highspeed. Upgrade to higher-tier Kimi Code plans.",
    );
});

/* AND A REAL OUTAGE IS LEFT ALONE, which is the half that must not regress: the retry ladder is right about
 * every one of these, and a classifier that grabbed them would turn a provider's bad minute into a dead turn. */
test.each([
    ["overloaded", JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })],
    ["a cooling credential", JSON.stringify({ error: { code: "model_cooldown", message: "All credentials for model kimi-k3 are cooling down" } })],
    ["a bare gateway error", "502 Bad Gateway"],
    ["an empty body", ""],
])("%s keeps riding the retry ladder", (_case, body) => {
    expect(routedRefusal(body)).toBeUndefined();
});

// A body that names a terminal refusal but carries no JSON to read still says something usable: the marker was
// found, so quoting the body beats reporting nothing.
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
    // One token out, one word in, no tools: on a healthy endpoint (which is never asked, since this only runs
    // inside a turn that is already failing) this is the cheapest request the wire allows.
    expect(asked?.body).toMatchObject({ model: "kimi-k2.7-code-highspeed", max_tokens: 1 });
});

test("an endpoint that answers is not a refusal", async () => {
    const refusal = await probeRoutedEndpoint(
        { baseUrl: "http://127.0.0.1:8789", authToken: "t", model: "kimi-k3" },
        { fetchFn: (() => Promise.resolve({ ok: true, text: () => Promise.resolve("") })) as unknown as typeof fetch },
    );
    expect(refusal).toBeUndefined();
});

/* THE PROBE'S ONE POWER IS TO END A TURN SOONER, so everything it cannot answer means "carry on as before".
 * A throwing fetch here used to be the whole turn's problem; now it is nobody's. */
test("a probe that cannot reach the endpoint changes nothing", async () => {
    const refusal = await probeRoutedEndpoint(
        { baseUrl: "http://127.0.0.1:8789", authToken: "t", model: "kimi-k3" },
        {
            fetchFn: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
        },
    );
    expect(refusal).toBeUndefined();
});
