import type { ToolDefinition } from "@intentic/extension-api";
import { answerToolMessage, toToolResult } from "./backend-tools.js";

// The host's MCP server over an extension's `api.tools.serve`: the extension says what the tools are; the host answers
// the protocol, turns whatever a call returns into MCP content, and reads a throw or a missing tool as a refusal.

const echo: ToolDefinition = {
    name: "echo",
    description: "Echoes x.",
    inputSchema: { type: "object", properties: { x: { type: "string" } } },
    call: async (args) => `echo ${String(args["x"])}`,
};
const broken: ToolDefinition = { name: "broken", description: "Throws.", inputSchema: { type: "object" }, call: () => Promise.reject(new Error("nope")) };

const serving = { id: "acme.tools", source: (card: { id: string } | undefined) => (card?.id === "narrow" ? [echo] : [echo, broken]) };
const signal = new AbortController().signal;

test("the handshake and a ping are the host's own, and a notification gets no answer", async () => {
    expect(await answerToolMessage(serving, { card: { id: "books", config: {} }, message: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } } }, signal)).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "books", version: "1.0.0" } },
    });
    expect(await answerToolMessage(serving, { message: { jsonrpc: "2.0", id: 2, method: "ping" } }, signal)).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    expect(await answerToolMessage(serving, { message: { jsonrpc: "2.0", method: "notifications/initialized" } }, signal)).toBeUndefined();
    expect(await answerToolMessage(serving, { message: { jsonrpc: "2.0", id: 3, method: "resources/list" } }, signal)).toEqual({
        jsonrpc: "2.0",
        id: 3,
        error: { code: -32601, message: `unsupported method "resources/list"` },
    });
});

test("the tool list follows the card it was asked for", async () => {
    const listed = await answerToolMessage(serving, { card: { id: "narrow", config: {} }, message: { jsonrpc: "2.0", id: 4, method: "tools/list" } }, signal);
    expect(listed).toEqual({ jsonrpc: "2.0", id: 4, result: { tools: [{ name: "echo", description: "Echoes x.", inputSchema: echo.inputSchema }] } });
});

test("a call answers as MCP content; a throw and a tool the card no longer offers answer as refusals the model reads", async () => {
    const call = (card: string, name: string) =>
        answerToolMessage(serving, { card: { id: card, config: {} }, message: { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name, arguments: { x: "hi" } } } }, signal);
    expect(await call("books", "echo")).toEqual({ jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: "echo hi" }] } });
    expect(await call("books", "broken")).toEqual({ jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: "nope" }], isError: true } });
    expect(await call("narrow", "broken")).toEqual({
        jsonrpc: "2.0",
        id: 5,
        result: { content: [{ type: "text", text: `no tool "broken" is offered to this card right now` }], isError: true },
    });
});

test("an extension that never served tools says so rather than listing nothing", async () => {
    expect(await answerToolMessage({ id: "acme.quiet", source: undefined }, { message: { jsonrpc: "2.0", id: 6, method: "tools/list" } }, signal)).toEqual({
        jsonrpc: "2.0",
        id: 6,
        error: { code: -32603, message: `the "acme.quiet" backend serves no tools (it never called api.tools.serve)` },
    });
});

test("a call the client gave up on answers as cancelled, without waiting for the tool", async () => {
    const hanging: ToolDefinition = { name: "hang", description: "Never answers.", inputSchema: { type: "object" }, call: () => new Promise(() => {}) };
    const client = new AbortController();
    const answer = answerToolMessage({ id: "acme.slow", source: () => [hanging] }, { message: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "hang" } } }, client.signal);
    client.abort();
    expect(await answer).toEqual({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "hang was cancelled" }], isError: true } });
});

test("what a call returns becomes content: text as text, a result as itself, anything else as its JSON", () => {
    expect(toToolResult("plain")).toEqual({ content: [{ type: "text", text: "plain" }] });
    expect(toToolResult({ content: [{ type: "text", text: "as is" }], isError: true })).toEqual({ content: [{ type: "text", text: "as is" }], isError: true });
    expect(toToolResult({ n: 1 })).toEqual({ content: [{ type: "text", text: `{\n  "n": 1\n}` }] });
});
