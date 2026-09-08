import type { hostContract, HostScopes } from "@intentic/sandbox-contract";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { RPCLink } from "@orpc/client/websocket";
import { RPCHandler } from "@orpc/server/websocket";
import { expect, test } from "vitest";
import { createHostRouter } from "./router.js";

// Both ends of the socket, over a real oRPC handler and link built from the same `hostContract`, so a
// procedure renamed or a schema tightened on one side fails here rather than on somebody's laptop.

// A pair of sockets wired to each other. Enough of the WebSocket surface for both adapters: the handler wants
// addEventListener + send, the link also wants removeEventListener + readyState.
class FakeSocket {
    readyState = 1;
    peer!: FakeSocket;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    addEventListener(type: string, fn: (event: never) => void): void {
        const set = this.listeners.get(type) ?? new Set();
        set.add(fn as (event: unknown) => void);
        this.listeners.set(type, set);
    }
    removeEventListener(type: string, fn: (event: never) => void): void {
        this.listeners.get(type)?.delete(fn as (event: unknown) => void);
    }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        // A microtask hop, so a call is never answered synchronously inside its own send.
        queueMicrotask(() => this.peer.emit("message", { data }));
    }
    close(): void {
        this.readyState = 3;
        this.emit("close", { code: 1000 });
        this.peer.emit("close", { code: 1000 });
    }
    emit(type: string, event: unknown): void {
        for (const fn of this.listeners.get(type) ?? []) {
            fn(event);
        }
    }
}

const scopes = (overrides: Partial<HostScopes> = {}): HostScopes => ({
    shell: "on",
    write: "on",
    screen: "on",
    control: "on",
    sandboxes: "on",
    sandboxRemove: "on",
    destructive: "on",
    ...overrides,
});

// The whole wiring: machine hosts the contract, "daemon" holds the client, over one socket, as in production.
const connectedPair = (initial: HostScopes = scopes()) => {
    const machineSocket = new FakeSocket();
    const daemonSocket = new FakeSocket();
    machineSocket.peer = daemonSocket;
    daemonSocket.peer = machineSocket;

    let live = initial;
    const logged: string[] = [];
    const handler = new RPCHandler(
        createHostRouter({
            scopes: () => live,
            setScopes: (next) => {
                live = next;
            },
            log: (message) => void logged.push(message),
        }),
    );
    handler.upgrade(machineSocket as unknown as WebSocket);
    const client: ContractRouterClient<typeof hostContract> = createORPCClient(new RPCLink({ websocket: daemonSocket as unknown as WebSocket }));
    return { client, logged, scopesNow: () => live };
};

test("the daemon can ask a machine what it is", async () => {
    const { client } = connectedPair();
    const facts = await client.describe();
    // Schema-checked at both ends: a missing field would fail the contract's output parse, not surface as
    // undefined three layers later.
    expect(facts.shell).toBeTypeOf("string");
    expect(facts.home).toBeTypeOf("string");
    expect(facts.roots.length).toBeGreaterThan(0);
});

test("a pushed grant takes effect on the machine", async () => {
    const { client, scopesNow } = connectedPair();
    expect(await client.setScopes({ shell: "off", write: "off", screen: "on", control: "off" })).toEqual({ ok: true });
    // The schema fills every switch the push left out, and each one it fills is off.
    expect(scopesNow()).toEqual({
        shell: "off",
        write: "off",
        screen: "on",
        control: "off",
        sandboxes: "off",
        sandboxRemove: "off",
        destructive: "off",
    });
});

test("a grant that does not satisfy the contract is refused before it reaches the machine", async () => {
    const { client, scopesNow } = connectedPair();
    // The whole reason for a typed link: a caller cannot push a scope value the machine has no meaning for.
    await expect(client.setScopes({ shell: "maybe", write: "off", screen: "on", control: "off" } as unknown as HostScopes)).rejects.toThrow();
    expect(scopesNow()).toEqual(scopes());
});

test("an MCP message rides the one opaque procedure and comes back answered", async () => {
    const { client } = connectedPair();
    const response = (await client.mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(response.result.tools.map((tool) => tool.name)).toContain("run_command");
});

test("the grant the machine enforces is the one it was last pushed, on the very next call", async () => {
    const { client } = connectedPair();
    await client.setScopes({ shell: "off", write: "off", screen: "off", control: "off" });
    const response = (await client.mcp({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "run_command", arguments: { command: "echo hi" } },
    })) as { result: { content: { text: string }[]; isError: boolean } };
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]?.text).toMatch(/Run commands.*switched off/);
});

test("concurrent calls do not cross: the link owns correlation now", async () => {
    const { client } = connectedPair();
    const [first, second, third] = await Promise.all([
        client.mcp({ jsonrpc: "2.0", id: 1, method: "ping" }),
        client.describe(),
        client.mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ]);
    // Same JSON-RPC id on two different MCP calls, in flight together: the link owns correlation, not a hand-rolled
    // remap in the daemon's hub.
    expect((first as { result: unknown }).result).toEqual({});
    expect((second as { shell: string }).shell).toBeTypeOf("string");
    expect((third as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0);
});

// The MCP notification path: nothing to answer, so the procedure resolves with nothing.
test("a notification round-trips as an empty answer rather than an error", async () => {
    const { client } = connectedPair();
    expect(await client.mcp({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
});

test("ping answers, which is what the daemon's heartbeat rides on", async () => {
    const { client } = connectedPair();
    expect(await client.ping()).toEqual({ ok: true });
});
