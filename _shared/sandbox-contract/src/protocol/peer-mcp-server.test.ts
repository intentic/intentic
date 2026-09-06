import { expect, test } from "vitest";
import { z } from "zod";
import { createMcpServer, type McpAuditEntry, textResult, tool } from "./peer-mcp-server.js";

/* The dispatch every peer serves its tools through, against two hand-written tools: what the model is shown,
 * what an arriving call is checked against, and the rule that a failed tool is a result and not a fault. */

class Refused extends Error {}

const build = () => {
    const audits: McpAuditEntry[] = [];
    const handle = createMcpServer<{ readonly allowed: boolean }>({
        serverInfo: () => ({ name: "intentic-test", version: "9.9.9" }),
        tools: [
            tool({
                name: "echo",
                description: "Say it back.",
                input: z.object({ text: z.string().min(1) }),
                run: async ({ text }, ctx) => {
                    if (!ctx.allowed) {
                        throw new Refused("the switch is off");
                    }
                    return textResult(text);
                },
            }),
            tool({
                name: "fail",
                description: "Always errs as a result.",
                input: z.object({}),
                run: async () => textResult("nope", true),
            }),
        ],
        noSuchTool: (name) => `This peer has no tool called "${name}".`,
        refused: (error) => error instanceof Refused,
        errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
        audit: (entry) => void audits.push(entry),
    });
    return { handle, audits };
};

const call = (name: string, args: Record<string, unknown>, allowed = true) => build().handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { allowed });

test("initialize names the peer and its build; ping answers empty; an unknown method is a JSON-RPC error", async () => {
    const { handle } = build();
    expect(await handle({ jsonrpc: "2.0", id: 1, method: "initialize" }, { allowed: true })).toMatchObject({
        result: { capabilities: { tools: {} }, serverInfo: { name: "intentic-test", version: "9.9.9" } },
    });
    expect(await handle({ jsonrpc: "2.0", id: 2, method: "ping" }, { allowed: true })).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    expect(await handle({ jsonrpc: "2.0", id: 3, method: "resources/list" }, { allowed: true })).toMatchObject({ error: { code: -32601 } });
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, { allowed: true })).toBeUndefined();
    expect(await handle("not an object", { allowed: true })).toMatchObject({ error: { code: -32600 } });
});

test("tools/list publishes each tool's schema as JSON Schema, without the dialect line", async () => {
    const { handle } = build();
    const listed = (await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { allowed: true })) as { result: { tools: { name: string; inputSchema: Record<string, unknown> }[] } };
    expect(listed.result.tools.map((entry) => entry.name)).toEqual(["echo", "fail"]);
    expect(listed.result.tools[0]?.inputSchema).toMatchObject({ type: "object", properties: { text: { type: "string" } } });
    expect(listed.result.tools[0]?.inputSchema).not.toHaveProperty("$schema");
});

test("a call is checked against the same schema, and a bad argument is a readable result, not a fault", async () => {
    expect(await call("echo", { text: "hi" })).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "hi" }], isError: false } });
    const bad = (await call("echo", { text: "" })) as { result: { content: { text: string }[]; isError: boolean } };
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0]?.text).toContain("text");
});

test("a tool this peer does not have answers in the peer's own words", async () => {
    expect(await call("delete_everything", {})).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: `This peer has no tool called "delete_everything".` }], isError: true },
    });
});

test("a thrown refusal and a thrown failure are both results, and the audit line says which", async () => {
    const { handle, audits } = build();
    const refused = (await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } }, { allowed: false })) as {
        result: { content: { text: string }[]; isError: boolean };
    };
    expect(refused.result).toEqual({ content: [{ type: "text", text: "the switch is off" }], isError: true });
    await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fail", arguments: {} } }, { allowed: true });
    await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "ok" } } }, { allowed: true });
    expect(audits).toEqual([
        { tool: "echo", args: { text: "hi" }, ok: false, failure: { refused: true, message: "the switch is off" } },
        { tool: "fail", args: {}, ok: false },
        { tool: "echo", args: { text: "ok" }, ok: true },
    ]);
});

test("an audit log that cannot be written never fails the answer", async () => {
    const handle = createMcpServer<undefined>({
        serverInfo: () => ({ name: "x", version: "1" }),
        tools: [tool({ name: "hi", description: "Hi.", input: z.object({}), run: async () => textResult("hi") })],
        noSuchTool: () => "no",
        refused: () => false,
        errorMessage: String,
        audit: () => {
            throw new Error("disk full");
        },
    });
    expect(await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hi", arguments: {} } }, undefined)).toMatchObject({ result: { isError: false } });
});
