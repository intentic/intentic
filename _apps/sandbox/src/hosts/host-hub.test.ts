import type { HostFacts, HostServerFrame } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { createHostHub, type HostConnection } from "./host-hub.js";

const facts: HostFacts = { os: "Ubuntu 24.04", arch: "x64", shell: "/bin/bash", home: "/home/me", roots: ["/home/me"] };

// A fake machine: records what the daemon sent it, and can answer any request it received.
const fakeMachine = (): { connection: HostConnection; sent: HostServerFrame[]; closed: string[] } => {
    const sent: HostServerFrame[] = [];
    const closed: string[] = [];
    return {
        sent,
        closed,
        connection: { send: (frame) => void sent.push(frame), close: (_code, reason) => void closed.push(reason) },
    };
};

const payloadOf = (frame: HostServerFrame): Record<string, unknown> => (frame as { payload: Record<string, unknown> }).payload;

test("a call reaches the machine and its answer comes back under the CALLER's id", async () => {
    const hub = createHostHub();
    const machine = fakeMachine();
    hub.attach("laptop", machine.connection);

    const pending = hub.call("laptop", { jsonrpc: "2.0", id: 7, method: "tools/list" });
    const forwarded = payloadOf(machine.sent[0]!);
    // The hub rewrites the id on the way out…
    expect(forwarded["id"]).not.toBe(7);
    hub.deliver("laptop", { jsonrpc: "2.0", id: forwarded["id"], result: { tools: [] } });
    // …and restores the caller's on the way back, so the remap is invisible at both ends.
    expect(await pending).toEqual({ jsonrpc: "2.0", id: 7, result: { tools: [] } });
});

// The reason the remap exists: two conversations both start their JSON-RPC ids at 1.
test("two callers using the same id are not crossed", async () => {
    const hub = createHostHub();
    const machine = fakeMachine();
    hub.attach("laptop", machine.connection);

    const first = hub.call("laptop", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "a" } });
    const second = hub.call("laptop", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "b" } });
    const [firstOut, secondOut] = [payloadOf(machine.sent[0]!), payloadOf(machine.sent[1]!)];
    expect(firstOut["id"]).not.toEqual(secondOut["id"]);

    // Answered out of order, on purpose — correlation must not depend on arrival order.
    hub.deliver("laptop", { jsonrpc: "2.0", id: secondOut["id"], result: { answer: "b" } });
    hub.deliver("laptop", { jsonrpc: "2.0", id: firstOut["id"], result: { answer: "a" } });
    expect(await first).toEqual({ jsonrpc: "2.0", id: 1, result: { answer: "a" } });
    expect(await second).toEqual({ jsonrpc: "2.0", id: 1, result: { answer: "b" } });
});

test("calling an offline machine rejects with something the model can read", async () => {
    const hub = createHostHub();
    await expect(hub.call("laptop", { jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow(/not connected right now/);
});

test("a disconnect rejects the calls in flight instead of leaving them hanging", async () => {
    const hub = createHostHub();
    const machine = fakeMachine();
    hub.attach("laptop", machine.connection);
    const pending = hub.call("laptop", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    hub.detach("laptop", machine.connection);
    await expect(pending).rejects.toThrow(/disconnected/);
    expect(hub.online("laptop")).toBe(false);
});

test("a reconnect replaces the old socket and closes it", () => {
    const hub = createHostHub();
    const first = fakeMachine();
    const second = fakeMachine();
    hub.attach("laptop", first.connection);
    hub.attach("laptop", second.connection);
    expect(first.closed).toEqual(["replaced"]);
    expect(hub.online("laptop")).toBe(true);

    // The STALE socket's close must not unregister the machine that already replaced it.
    hub.detach("laptop", first.connection);
    expect(hub.online("laptop")).toBe(true);
});

test("state remembers what an offline machine last reported, and says it is offline", () => {
    const hub = createHostHub();
    const machine = fakeMachine();
    hub.attach("laptop", machine.connection);
    hub.hello("laptop", "0.1.0", facts);
    expect(hub.state("laptop")).toMatchObject({ online: true, version: "0.1.0", facts });

    hub.detach("laptop", machine.connection);
    const state = hub.state("laptop");
    expect(state.online).toBe(false);
    expect(state.facts).toEqual(facts);
    expect(state.lastSeen).toBeTypeOf("number");
});

test("pushScopes reaches a connected machine and reports when there is nobody to reach", () => {
    const hub = createHostHub();
    const machine = fakeMachine();
    hub.attach("laptop", machine.connection);
    expect(hub.pushScopes("laptop", { shell: "on", write: "off", screen: "on" })).toBe(true);
    expect(machine.sent[0]).toEqual({ type: "scopes", scopes: { shell: "on", write: "off", screen: "on" } });
    expect(hub.pushScopes("desktop", { shell: "on", write: "off", screen: "on" })).toBe(false);
});

test("disconnect cuts the socket and fails the calls in flight", async () => {
    const hub = createHostHub();
    const machine = fakeMachine();
    hub.attach("laptop", machine.connection);
    const pending = hub.call("laptop", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    hub.disconnect("laptop", "revoked");
    await expect(pending).rejects.toThrow(/revoked/);
    expect(machine.closed).toEqual(["revoked"]);
});

test("a response nobody is waiting for is dropped, not crashed on", () => {
    const hub = createHostHub();
    const machine = fakeMachine();
    hub.attach("laptop", machine.connection);
    expect(() => hub.deliver("laptop", { jsonrpc: "2.0", id: 999, result: {} })).not.toThrow();
    expect(() => hub.deliver("unknown-machine", { jsonrpc: "2.0", id: 1, result: {} })).not.toThrow();
});

test("a call that goes unanswered times out rather than leaking a pending promise", async () => {
    vi.useFakeTimers();
    try {
        const hub = createHostHub();
        const machine = fakeMachine();
        hub.attach("laptop", machine.connection);
        const pending = hub.call("laptop", { jsonrpc: "2.0", id: 1, method: "tools/list" });
        const settled = expect(pending).rejects.toThrow(/did not answer/);
        await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1000);
        await settled;
    } finally {
        vi.useRealTimers();
    }
});
