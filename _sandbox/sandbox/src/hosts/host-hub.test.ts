import type { HostFacts } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { createHostHub, type HostClient } from "./host-hub.js";

/* What is left of the hub once oRPC owns the wire: the roster, liveness, and what to do when a machine goes.
 * Request/response correlation is not tested here any more because it is not implemented here any more — the
 * link does it, and _computers/host/src/link.test.ts proves it over a real handler.
 *
 * The `mcp` calls below therefore assert PLUMBING (does the right machine get it, what happens when it is gone),
 * never protocol. */

const facts: HostFacts = { os: "Ubuntu 24.04", arch: "x64", shell: "/bin/bash", home: "/home/me", roots: ["/home/me"] };
const logger = { warn: () => {} };

const fakeMachine = () => {
    const closed: string[] = [];
    const client = {
        describe: vi.fn(async () => facts),
        setScopes: vi.fn(async () => ({ ok: true })),
        ping: vi.fn(async () => ({ ok: true })),
        mcp: vi.fn(async (payload: unknown) => ({ echoed: payload })),
    } as unknown as HostClient;
    return { client, closed, connection: { client, close: (_code: number, reason: string) => void closed.push(reason) } };
};

test("an mcp call reaches the machine that was asked for", async () => {
    const hub = createHostHub(logger);
    const machine = fakeMachine();
    hub.attach("laptop", machine.connection);
    expect(await hub.mcp("laptop", { jsonrpc: "2.0", id: 1, method: "tools/list" })).toEqual({
        echoed: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
});

test("calling an offline machine rejects with something the model can read", async () => {
    const hub = createHostHub(logger);
    await expect(hub.mcp("laptop", { jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow(/not connected right now/);
});

test("a reconnect replaces the old socket and closes it", () => {
    const hub = createHostHub(logger);
    const first = fakeMachine();
    const second = fakeMachine();
    hub.attach("laptop", first.connection);
    hub.attach("laptop", second.connection);
    expect(first.closed).toEqual(["replaced"]);
    expect(hub.online("laptop")).toBe(true);
});

// The stale socket's close arrives AFTER the new one attached — a laptop waking from sleep does this routinely.
test("a stale socket's detach does not unregister the machine that replaced it", () => {
    const hub = createHostHub(logger);
    const first = fakeMachine();
    const second = fakeMachine();
    const detachFirst = hub.attach("laptop", first.connection);
    hub.attach("laptop", second.connection);
    detachFirst();
    expect(hub.online("laptop")).toBe(true);
});

test("detach takes the machine offline but keeps what it told us", () => {
    const hub = createHostHub(logger);
    const machine = fakeMachine();
    const detach = hub.attach("laptop", machine.connection);
    hub.announce("laptop", "0.1.0");
    hub.observe("laptop", facts);
    expect(hub.state("laptop")).toMatchObject({ online: true, version: "0.1.0", facts });

    detach();
    const state = hub.state("laptop");
    expect(state.online).toBe(false);
    expect(state.facts).toEqual(facts);
    expect(state.lastSeen).toBeTypeOf("number");
});

test("pushScopes reaches a connected machine and reports when there is nobody to reach", async () => {
    const hub = createHostHub(logger);
    const machine = fakeMachine();
    hub.attach("laptop", machine.connection);
    expect(await hub.pushScopes("laptop", { shell: "on", write: "off", screen: "on", control: "off", sandboxes: "off" })).toBe(true);
    expect(machine.client.setScopes).toHaveBeenCalledWith({ shell: "on", write: "off", screen: "on", control: "off", sandboxes: "off" });
    expect(await hub.pushScopes("desktop", { shell: "on", write: "off", screen: "on", control: "off", sandboxes: "off" })).toBe(false);
});

test("disconnect cuts the socket and takes the machine off the roster", async () => {
    const hub = createHostHub(logger);
    const machine = fakeMachine();
    hub.attach("laptop", machine.connection);
    hub.disconnect("laptop", "revoked");
    expect(machine.closed).toEqual(["revoked"]);
    expect(hub.online("laptop")).toBe(false);
    await expect(hub.mcp("laptop", {})).rejects.toThrow(/not connected/);
});

test("the tool list survives a machine going offline, so an asleep laptop stays usable in a turn", () => {
    const hub = createHostHub(logger);
    const machine = fakeMachine();
    const detach = hub.attach("laptop", machine.connection);
    hub.rememberTools("laptop", { tools: [{ name: "run_command" }] });
    detach();
    expect(hub.knownTools("laptop")).toEqual({ tools: [{ name: "run_command" }] });
});

/* A lid closing does not always produce a close frame — the socket can simply stop answering. The card's dot is
 * read as "the agent can work here right now", so liveness has to be a probe rather than a memory. */
test("a machine that stops answering the heartbeat is dropped", async () => {
    vi.useFakeTimers();
    try {
        const hub = createHostHub(logger);
        const machine = fakeMachine();
        (machine.client.ping as unknown as { mockRejectedValue: (error: Error) => void }).mockRejectedValue(new Error("gone"));
        hub.attach("laptop", machine.connection);
        expect(hub.online("laptop")).toBe(true);
        await vi.advanceTimersByTimeAsync(31_000);
        expect(hub.online("laptop")).toBe(false);
        expect(machine.closed).toEqual(["no answer"]);
    } finally {
        vi.useRealTimers();
    }
});

test("a healthy machine stays online across heartbeats", async () => {
    vi.useFakeTimers();
    try {
        const hub = createHostHub(logger);
        const machine = fakeMachine();
        hub.attach("laptop", machine.connection);
        await vi.advanceTimersByTimeAsync(95_000);
        expect(machine.client.ping).toHaveBeenCalledTimes(3);
        expect(hub.online("laptop")).toBe(true);
    } finally {
        vi.useRealTimers();
    }
});
