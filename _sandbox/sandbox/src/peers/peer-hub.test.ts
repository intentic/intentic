import { expect, test, vi } from "vitest";
import { createPeerHub, type PeerClient } from "./peer-hub.js";

/* What is left of a hub once oRPC owns the wire: the roster, liveness, and what to do when a peer goes. */

interface Facts {
    readonly os: string;
}
interface Scopes {
    readonly shell: "on" | "off";
}
interface Client extends PeerClient<Facts, Scopes> {
    describe: ReturnType<typeof vi.fn<(input?: undefined, options?: { signal?: AbortSignal }) => Promise<Facts>>>;
    setScopes: ReturnType<typeof vi.fn<(scopes: Scopes) => Promise<{ ok: true }>>>;
    ping: ReturnType<typeof vi.fn<() => Promise<{ ok: true }>>>;
    mcp: ReturnType<typeof vi.fn<(payload: unknown) => Promise<unknown>>>;
}

const facts: Facts = { os: "Ubuntu 24.04" };
const logger = { warn: () => {} };
const spec = { domain: "hosts" as const, heartbeatMs: 30_000, callTimeoutMs: 60_000, offline: (id: string) => `"${id}" is not connected right now` };
const hub = () => createPeerHub<Client, { version: string }, Facts, Scopes>(spec, logger);

const fakePeer = () => {
    const closed: string[] = [];
    const client: Client = {
        describe: vi.fn(async () => facts),
        setScopes: vi.fn(async () => ({ ok: true }) as const),
        ping: vi.fn(async () => ({ ok: true }) as const),
        mcp: vi.fn(async (payload: unknown) => ({ echoed: payload })),
    };
    return { client, closed, connection: { client, close: (_code: number, reason: string) => void closed.push(reason), announced: { version: "0.1.0" } } };
};

test("an mcp call reaches the peer that was asked for", async () => {
    const live = hub();
    const peer = fakePeer();
    live.attach("laptop", peer.connection);
    expect(await live.mcp("laptop", { jsonrpc: "2.0", id: 1, method: "tools/list" })).toEqual({
        echoed: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
});

test("calling an offline peer rejects with the door's own sentence", async () => {
    await expect(hub().mcp("laptop", { jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow(`"laptop" is not connected right now`);
});

test("a reconnect replaces the old socket and closes it", () => {
    const live = hub();
    const first = fakePeer();
    const second = fakePeer();
    live.attach("laptop", first.connection);
    live.attach("laptop", second.connection);
    expect(first.closed).toEqual(["replaced"]);
    expect(live.online("laptop")).toBe(true);
    expect(live.connected()).toEqual(["laptop"]);
});

// The stale socket's close arrives AFTER the new one attached: a laptop waking from sleep does this routinely.
test("a stale socket's detach does not unregister the peer that replaced it", () => {
    const live = hub();
    const first = fakePeer();
    const second = fakePeer();
    const detachFirst = live.attach("laptop", first.connection);
    live.attach("laptop", second.connection);
    detachFirst();
    expect(live.online("laptop")).toBe(true);
});

test("detach takes the peer offline but keeps what it told us", () => {
    const live = hub();
    const peer = fakePeer();
    const detach = live.attach("laptop", peer.connection);
    live.observe("laptop", facts);
    expect(live.state("laptop")).toMatchObject({ online: true, announced: { version: "0.1.0" }, facts });

    detach();
    const state = live.state("laptop");
    expect(state.online).toBe(false);
    expect(state.facts).toEqual(facts);
    expect(state.announced).toEqual({ version: "0.1.0" });
    expect(state.lastSeen).toBeTypeOf("number");
});

test("a fresh attach keeps the facts the peer reported last time, under the hello it just sent", () => {
    const live = hub();
    const detach = live.attach("laptop", fakePeer().connection);
    live.observe("laptop", facts);
    detach();
    const again = fakePeer();
    live.attach("laptop", { ...again.connection, announced: { version: "0.2.0" } });
    expect(live.state("laptop")).toMatchObject({ online: true, announced: { version: "0.2.0" }, facts });
});

test("announce replaces the hello's claim on a live peer and is ignored for an absent one", () => {
    const live = hub();
    live.announce("laptop", { version: "9" });
    expect(live.state("laptop")).toEqual({ online: false });
    live.attach("laptop", fakePeer().connection);
    live.announce("laptop", { version: "9" });
    expect(live.state("laptop").announced).toEqual({ version: "9" });
});

test("refresh re-asks a live peer within its budget and keeps the last answer when it does not answer", async () => {
    const live = hub();
    const peer = fakePeer();
    live.attach("laptop", peer.connection);
    live.observe("laptop", facts);
    peer.client.describe.mockResolvedValueOnce({ os: "Ubuntu 25.04" });
    await live.refresh("laptop", 1_000);
    expect(live.state("laptop").facts).toEqual({ os: "Ubuntu 25.04" });
    peer.client.describe.mockRejectedValueOnce(new Error("gone"));
    await live.refresh("laptop", 1_000);
    expect(live.state("laptop").facts).toEqual({ os: "Ubuntu 25.04" });
    expect(peer.client.describe).toHaveBeenCalledTimes(2);
});

test("pushScopes reaches a connected peer and reports when there is nobody to reach", async () => {
    const live = hub();
    const peer = fakePeer();
    live.attach("laptop", peer.connection);
    expect(await live.pushScopes("laptop", { shell: "on" })).toBe(true);
    expect(peer.client.setScopes).toHaveBeenCalledWith({ shell: "on" });
    expect(await live.pushScopes("desktop", { shell: "on" })).toBe(false);
});

test("disconnect cuts the socket and takes the peer off the roster, forgetting what it said", async () => {
    const live = hub();
    const peer = fakePeer();
    live.attach("laptop", peer.connection);
    live.observe("laptop", facts);
    live.disconnect("laptop", "revoked");
    expect(peer.closed).toEqual(["revoked"]);
    expect(live.online("laptop")).toBe(false);
    expect(live.state("laptop")).toEqual({ online: false });
    await expect(live.mcp("laptop", {})).rejects.toThrow("not connected");
});

test("the tool list survives a peer going offline, so an asleep laptop stays usable in a turn", () => {
    const live = hub();
    const detach = live.attach("laptop", fakePeer().connection);
    live.rememberTools("laptop", { tools: [{ name: "run_command" }] });
    detach();
    expect(live.knownTools("laptop")).toEqual({ tools: [{ name: "run_command" }] });
});

// Waiting for a turn to list them is what left a browser connected between turns publishing nothing: it went to sleep
// before anything asked, and the turn that followed could not see it at all.
test("a peer is asked for its tools the moment it connects, not when a turn first wants them", async () => {
    const live = hub();
    const peer = fakePeer();
    peer.client.mcp.mockResolvedValueOnce({ jsonrpc: "2.0", id: "hosts-tools", result: { tools: [{ name: "screenshot" }] } });
    const detach = live.attach("laptop", peer.connection);
    await vi.waitFor(() => expect(live.knownTools("laptop")).toEqual({ tools: [{ name: "screenshot" }] }));
    expect(peer.client.mcp).toHaveBeenCalledWith(
        { jsonrpc: "2.0", id: "hosts-tools", method: "tools/list", params: {} },
        expect.objectContaining({ signal: expect.anything() }),
    );
    detach();
    expect(live.knownTools("laptop")).toEqual({ tools: [{ name: "screenshot" }] });
});

// A peer that cannot answer at connect is the ordinary case of a dying socket, not a reason to forget what it published
// last time; nor may it take the attach down with it.
test("a peer that will not answer for its tools keeps the ones it published before", async () => {
    const live = hub();
    live.rememberTools("laptop", { tools: [{ name: "run_command" }] });
    const peer = fakePeer();
    peer.client.mcp.mockRejectedValueOnce(new Error("gone"));
    live.attach("laptop", peer.connection);
    expect(live.online("laptop")).toBe(true);
    await vi.waitFor(() => expect(peer.client.mcp).toHaveBeenCalledTimes(1));
    expect(live.knownTools("laptop")).toEqual({ tools: [{ name: "run_command" }] });
});

// The memory outlives the process, which is the half a restart used to lose: a browser shut overnight would come back
// with no tools at all, and a turn reading its skill would find nothing to call.
test("a hub built over a memory that already holds a peer lists its tools before it ever connects", () => {
    const stored = new Map<string, unknown>([["hosts:laptop", { tools: [{ name: "run_command" }] }]]);
    const live = createPeerHub<Client, { version: string }, Facts, Scopes>(spec, logger, {
        get: (key) => stored.get(key),
        set: (key, tools) => void stored.set(key, tools),
    });
    expect(live.knownTools("laptop")).toEqual({ tools: [{ name: "run_command" }] });
    live.rememberTools("laptop", { tools: [{ name: "run_command" }, { name: "screenshot" }] });
    // Keyed by door as well as name, since one memory serves every door.
    expect(stored.get("hosts:laptop")).toEqual({ tools: [{ name: "run_command" }, { name: "screenshot" }] });
});

/* A lid closing does not always produce a close frame: the socket can simply stop answering. */
test("a peer that stops answering the heartbeat is dropped", async () => {
    vi.useFakeTimers();
    try {
        const live = hub();
        const peer = fakePeer();
        peer.client.ping.mockRejectedValue(new Error("gone"));
        live.attach("laptop", peer.connection);
        expect(live.online("laptop")).toBe(true);
        await vi.advanceTimersByTimeAsync(31_000);
        expect(live.online("laptop")).toBe(false);
        expect(peer.closed).toEqual(["no answer"]);
    } finally {
        vi.useRealTimers();
    }
});

test("a healthy peer stays online across heartbeats, at the door's own cadence", async () => {
    vi.useFakeTimers();
    try {
        const live = createPeerHub<Client, { version: string }, Facts, Scopes>({ ...spec, heartbeatMs: 20_000 }, logger);
        const peer = fakePeer();
        live.attach("laptop", peer.connection);
        await vi.advanceTimersByTimeAsync(65_000);
        expect(peer.client.ping).toHaveBeenCalledTimes(3);
        expect(live.online("laptop")).toBe(true);
    } finally {
        vi.useRealTimers();
    }
});
