import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordToolSchemas, schemaCostOf, ToolListingSchema, toolSchemasAnswer } from "./tool-schemas-log.js";

const tool = (name: string, description: string) => ({ name, description, inputSchema: { type: "object", properties: {} } });
const listing = (...tools: ReturnType<typeof tool>[]) => ToolListingSchema.parse({ tools });

test("a listing costs its serialized names, descriptions and schemas, a quarter of the characters in tokens", () => {
    const cost = schemaCostOf(listing(tool("a", "x".repeat(100)), tool("b", "short")));
    const chars = [tool("a", "x".repeat(100)), tool("b", "short")].reduce((sum, one) => sum + JSON.stringify(one).length, 0);
    expect(cost).toEqual({ tools: 2, chars, tokens: Math.ceil(chars / 4), heaviest: [{ name: "a", chars: expect.any(Number) }, { name: "b", chars: expect.any(Number) }] });
});

test("the answer is a conversation's latest turn by server, heaviest first, and an older turn's listing is left out", async () => {
    const root = mkdtempSync(join(tmpdir(), "tool-schemas-"));
    const logs = join(root, "logs");
    const hour = 3_600_000;
    await recordToolSchemas(logs, { conversationId: "c1", server: "rog", kind: "device", listing: listing(tool("run_command", "y".repeat(4000))) }, 0);
    await recordToolSchemas(logs, { conversationId: "c1", server: "devices", kind: "devices", listing: listing(tool("run_command", "y".repeat(4000))) }, hour);
    await recordToolSchemas(logs, { conversationId: "c1", server: "ui", kind: "sdk", listing: listing(tool("ask", "z")) }, hour + 1000);
    await recordToolSchemas(logs, { conversationId: "c2", server: "web", kind: "browser", listing: listing(tool("browser_navigate", "w")) }, hour + 2000);

    const answer = await toolSchemasAnswer(root, { conversationId: "c1" });
    expect(answer).toMatch(/^Tool schemas by server for c1's latest turn .*: 2 servers, 2 tools, /);
    expect(answer.indexOf("devices (devices)")).toBeLessThan(answer.indexOf("ui (sdk)"));
    expect(answer).not.toContain("rog (device)");
    // Left unnamed, the newest conversation that recorded one.
    expect(await toolSchemasAnswer(root, {})).toContain("for c2's latest turn");
    expect(await toolSchemasAnswer(root, { conversationId: "c3" })).toMatch(/^No tool listings recorded for c3/);
});
