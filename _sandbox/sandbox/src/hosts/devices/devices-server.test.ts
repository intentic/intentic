import type { MountCall } from "../../agent/tools/turn-mounts.routes.js";
import type { RpcMessage } from "../../agent/tools/turn-mounts.js";
import { createDevicesEndpoint, type DevicesDeps } from "./devices-server.js";

const call: MountCall = { name: "devices", conversationId: "c1", signal: new AbortController().signal };
const target = { kind: "devices" as const, ids: ["rog", "omen"] };

const runCommand = {
    name: "run_command",
    description: "Run a command on this device.",
    inputSchema: { type: "object", properties: { command: { type: "string" }, timeoutMs: { type: "integer" } }, required: ["command"] },
};
const screenshot = { name: "screenshot", description: "The screen.", inputSchema: { type: "object", properties: {} } };

// A bridge per card that answers tools/list with what that card has and echoes a call back, recording what it was sent.
const bridge = (online: readonly string[], tools: Record<string, readonly object[]>) => {
    const sent: { id: string; message: RpcMessage }[] = [];
    const deps: DevicesDeps = {
        device: async ({ id }, message) => {
            sent.push({ id, message });
            if (message.method === "tools/list") {
                return { jsonrpc: "2.0", id: message.id ?? null, result: { tools: tools[id] ?? [] } };
            }
            if (!online.includes(id)) {
                return { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32000, message: `"${id}" is not connected right now.` } };
            }
            return { jsonrpc: "2.0", id: message.id ?? null, result: { content: [{ type: "text", text: `ran on ${id}` }] } };
        },
        connected: async (ids) => ids.filter((id) => online.includes(id)),
        describe: async (ids) => ids.map((id) => `${id}: Windows`),
    };
    return { deps, sent };
};

// The answer as text, whatever part of it carries the words.
const textOf = (answer: RpcMessage | undefined): string => JSON.stringify(answer ?? {});

test("lists each tool once, with a required device argument naming the granted computers", async () => {
    const { deps } = bridge(["rog", "omen"], { rog: [runCommand, screenshot], omen: [runCommand] });
    const answered = await createDevicesEndpoint(deps)(target, { jsonrpc: "2.0", id: 1, method: "tools/list" }, call);
    expect(answered).toMatchObject({
        result: {
            tools: [
                {
                    name: "run_command",
                    inputSchema: {
                        required: ["device", "command"],
                        // Bash's name for the deadline is listed beside timeoutMs on run_command alone.
                        properties: { device: { enum: ["rog", "omen"] }, command: { type: "string" }, timeout: { type: "integer" } },
                    },
                },
                // A tool only some computers have says where it is.
                { name: "screenshot", inputSchema: { properties: { device: { description: expect.stringContaining("Only on rog") } } } },
            ],
        },
    });
    expect(textOf(answered).match(/"timeout"/g)).toHaveLength(1);
});

test("routes a call to the named card without the device argument, reading run_command's timeout as timeoutMs", async () => {
    const { deps, sent } = bridge(["rog", "omen"], {});
    const answer = await createDevicesEndpoint(deps)(
        target,
        { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "run_command", arguments: { device: "OMEN", command: "ls", timeout: 5000 } } },
        call,
    );
    expect(textOf(answer)).toContain("ran on omen");
    expect(sent).toEqual([
        { id: "omen", message: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "run_command", arguments: { command: "ls", timeoutMs: 5000 } } } },
    ]);
});

test("an unknown or missing device is a tool error naming the connected computers", async () => {
    const { deps, sent } = bridge(["rog"], {});
    const endpoint = createDevicesEndpoint(deps);
    const unknown = await endpoint(target, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "describe", arguments: { device: "laptop" } } }, call);
    expect(unknown).toMatchObject({ result: { isError: true } });
    expect(textOf(unknown)).toContain('No connected computer is named \\"laptop\\". Connected now: \\"rog\\"; granted to this turn: \\"rog\\", \\"omen\\".');
    const missing = await endpoint(target, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "describe", arguments: {} } }, call);
    expect(textOf(missing)).toContain("describe needs `device`");
    expect(sent).toEqual([]);
});

test("a disconnected computer keeps its bridge's own words, with where else a call could go", async () => {
    const { deps } = bridge(["rog"], {});
    const answered = await createDevicesEndpoint(deps)(
        target,
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "describe", arguments: { device: "omen" } } },
        call,
    );
    expect(answered?.error).toEqual({ code: -32000, message: '"omen" is not connected right now. Connected now: "rog".' });
});

test("answers the handshake itself, listing the computers once in its instructions", async () => {
    const { deps, sent } = bridge([], {});
    const answered = await createDevicesEndpoint(deps)(target, { jsonrpc: "2.0", id: 0, method: "initialize" }, call);
    expect(answered).toMatchObject({ result: { instructions: expect.stringContaining("- rog: Windows\n- omen: Windows") } });
    expect(sent).toEqual([]);
});
