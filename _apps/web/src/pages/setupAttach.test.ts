import { afterEach, expect, test, vi } from "vitest";
import { daemonUrlProblem, nameFromDaemonUrl, normalizeDaemonUrl, probeDaemon } from "./setupAttach";

afterEach(() => {
    vi.unstubAllGlobals();
});

test("a bare hostname is accepted — https is assumed, not demanded of the user", () => {
    expect(normalizeDaemonUrl(`sandbox.example.com`)).toBe(`https://sandbox.example.com`);
    expect(normalizeDaemonUrl(`  sandbox.example.com  `)).toBe(`https://sandbox.example.com`);
});

test("a pasted address bar is stripped back to what daemon paths append to", () => {
    expect(normalizeDaemonUrl(`https://sandbox.example.com/`)).toBe(`https://sandbox.example.com`);
    expect(normalizeDaemonUrl(`https://sandbox.example.com/?tab=chat#top`)).toBe(`https://sandbox.example.com`);
    // A path prefix survives: the sandbox may sit under a subpath on the user's own reverse proxy.
    expect(normalizeDaemonUrl(`https://example.com/sandbox/`)).toBe(`https://example.com/sandbox`);
});

test("http and dotless hosts are rejected — the app is HTTPS, so the browser would block those calls", () => {
    expect(normalizeDaemonUrl(`http://sandbox.example.com`)).toBeUndefined();
    expect(normalizeDaemonUrl(`localhost:8787`)).toBeUndefined();
    expect(normalizeDaemonUrl(`not a domain`)).toBeUndefined();
    expect(normalizeDaemonUrl(``)).toBeUndefined();
});

test("http gets its own explanation instead of a generic invalid-address message", () => {
    expect(daemonUrlProblem(`http://sandbox.example.com`)).toContain(`https`);
    expect(daemonUrlProblem(`nonsense`)).toContain(`sandbox.example.com`);
    // Nothing typed yet is not a mistake; a valid one has no problem to report.
    expect(daemonUrlProblem(``)).toBeUndefined();
    expect(daemonUrlProblem(`sandbox.example.com`)).toBeUndefined();
});

test("the default name is the label that distinguishes sandboxes on a shared zone", () => {
    expect(nameFromDaemonUrl(`https://staging.example.com`)).toBe(`staging`);
    expect(nameFromDaemonUrl(`https://example.com`)).toBe(`example`);
});

const stubFetch = (routes: Record<string, { status: number; body?: unknown }>) => {
    const calls: { url: string; connect: string | null }[] = [];
    vi.stubGlobal(`fetch`, (url: string, init?: RequestInit) => {
        const route = routes[url];
        calls.push({ url, connect: new Headers(init?.headers).get(`x-intentic-connect`) });
        if (route === undefined) {
            return Promise.reject(new TypeError(`Failed to fetch`));
        }
        return Promise.resolve(new Response(JSON.stringify(route.body ?? {}), { status: route.status }));
    });
    return calls;
};

test("a healthy daemon that authorizes the caller is ok, and the connect token rides the bind request", async () => {
    const calls = stubFetch({
        "https://sandbox.example.com/health": { status: 200, body: { ok: true } },
        "https://sandbox.example.com/environment": { status: 200, body: {} },
    });
    expect(await probeDaemon({ daemonUrl: `https://sandbox.example.com`, idToken: `id-tok`, connectToken: `connect-tok` })).toEqual({ kind: `ok` });
    // /health is deliberately unauthenticated — only the authorize probe carries the first-bind token.
    expect(calls.map((call) => call.connect)).toEqual([null, `connect-tok`]);
});

test("an unreachable address (DNS, TLS, or a CORS-blocked daemon) reports unreachable, not a status", async () => {
    stubFetch({});
    expect(await probeDaemon({ daemonUrl: `https://sandbox.example.com`, idToken: `id-tok` })).toEqual({ kind: `unreachable` });
});

test("401 means the daemon is up but unclaimed — the actionable answer is its connection token", async () => {
    stubFetch({
        "https://sandbox.example.com/health": { status: 200 },
        "https://sandbox.example.com/environment": { status: 401, body: { error: `unauthorized` } },
    });
    expect(await probeDaemon({ daemonUrl: `https://sandbox.example.com`, idToken: `id-tok` })).toEqual({ kind: `needs-token` });
});

test("403 carries the daemon's own reason — it names the account the sandbox belongs to", async () => {
    stubFetch({
        "https://sandbox.example.com/health": { status: 200 },
        "https://sandbox.example.com/environment": { status: 403, body: { error: `this sandbox is registered to someone@else.com` } },
    });
    expect(await probeDaemon({ daemonUrl: `https://sandbox.example.com`, idToken: `id-tok` })).toEqual({
        kind: `denied`,
        message: `this sandbox is registered to someone@else.com`,
    });
});

test("something answering that isn't a healthy daemon is reported as such, with its status", async () => {
    stubFetch({ "https://sandbox.example.com/health": { status: 502 } });
    const outcome = await probeDaemon({ daemonUrl: `https://sandbox.example.com`, idToken: `id-tok` });
    expect(outcome.kind).toBe(`rejected`);
    expect(outcome).toMatchObject({ message: expect.stringContaining(`502`) });
});
