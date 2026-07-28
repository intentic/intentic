import { afterEach, expect, it, vi } from "vitest";

// sandboxClient is the one thing left REAL here — the bug under test lived in the gap between agentActions and
// the request that actually goes out, so a mock at that seam would assert the very thing that was wrong. What is
// mocked is only what agentActions imports for its OTHER actions (startAgent's tab/caret/route, the post-land
// cache invalidation) and whose module scope wants a browser: ui's useDevice reads window.matchMedia at import,
// the router builds a history, and useSandbox reaches environment.ts's window.env. The useSandbox stub serves
// both consumers — sandboxClient reads `daemonUrl`/`active`, agentActions reads `sandboxKey`.
vi.mock("@intentic-app/ui", () => ({ useDevice: () => ({ mobile: { value: false } }) }));
vi.mock("../chat/useChat", () => ({
    useChat: () => ({ conversations: { value: [] }, newChat: () => ({ conversationId: `c1` }) }),
    focusComposer: () => {},
}));
vi.mock("../queryPersistence", () => ({ queryClient: { invalidateQueries: async () => undefined } }));
vi.mock("../../router", () => ({ router: { push: vi.fn() } }));
vi.mock("../sandbox/useSandbox", () => ({
    useSandbox: () => ({ active: { value: { token: `connect` } }, daemonUrl: { value: `https://daemon.test` } }),
    sandboxKey: (...parts: unknown[]) => parts,
}));
vi.mock("../sandbox/sandboxSession", () => ({ useSandboxSession: () => ({ getSessionToken: async () => `session-token` }) }));

const { landAgent } = await import("./agentActions");

// Every request fetch was handed, as the Request the daemon would have received.
const sent: Request[] = [];
const stubFetch = (): void => {
    vi.stubGlobal(`fetch`, (url: string, init?: RequestInit) => {
        sent.push(new Request(url, init));
        return Promise.resolve(Response.json({ landed: true }));
    });
};

afterEach(() => {
    sent.length = 0;
    vi.unstubAllGlobals();
});

/* THE LAND REQUEST'S CONTENT-TYPE, pinned because its absence was invisible from this side and fatal on the
 * other. `fetch` labels a bare string body `text/plain`; the daemon's oRPC handler then parses the body as a
 * STRING rather than an object, and its compact-input codec hands that string to the route schema as the whole
 * input — dropping the `{id}` it took from the path. So every land came back 400 "Input validation failed",
 * which took out the review panel's Land/Merge AND the only route an errored or conflicted card had to the
 * Finished lane. Asserted on the Request rather than on the init object, because sandboxRequest rebuilds the
 * headers on the way out and it is the wire that has to be right. */
it("sends the land body as JSON, so the daemon parses an object and keeps the agent id from the path", async () => {
    stubFetch();
    await expect(landAgent(`a1`)).resolves.toEqual({ landed: true });
    const [request] = sent;
    expect(request?.url).toBe(`https://daemon.test/agents/a1/land`);
    expect(request?.headers.get(`content-type`)).toBe(`application/json`);
    // The drag-to-Finished drop and the panel's Land button both take the default: check-only, so a refusal
    // leaves the workspace byte-identical.
    expect(await request?.json()).toEqual({ mode: `check` });
});

it("carries an explicit mode, so the conflict report's Merge is a different request and not the same one twice", async () => {
    stubFetch();
    await landAgent(`a1`, `merge`);
    expect(sent[0]?.headers.get(`content-type`)).toBe(`application/json`);
    expect(await sent[0]?.json()).toEqual({ mode: `merge` });
});
