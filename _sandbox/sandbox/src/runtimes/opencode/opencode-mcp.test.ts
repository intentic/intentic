import { createHash } from "node:crypto";
import type { AgentTool } from "../../agent/tools/agent-tools.js";
import { mcpServersOf, mcpToolNameOf, openCodeMounts, visibleToolsOf } from "./opencode-mcp.js";

// How a turn's MCP servers are named, configured and shown on the one OpenCode server every conversation shares.

const WEB: AgentTool = { name: "web", url: "http://127.0.0.1:7000/mcp/web", token: "turn-bearer", timeoutMs: 120_000 };
const CARD: AgentTool = { name: "acme.billing", url: "https://mcp.example.com/billing" };

// The conversation's key as the module derives it, recomputed rather than transcribed.
const keyOf = (conversationId: string): string => createHash("sha256").update(conversationId).digest("hex").slice(0, 8);

test("a conversation's servers are named for it, the same on every turn, and another conversation's differently", () => {
    const first = openCodeMounts("chat-1", [WEB]);

    expect(first.prefix).toBe(`intentic_${keyOf("chat-1")}_`);
    expect(openCodeMounts("chat-1", []).prefix).toBe(first.prefix);
    expect(openCodeMounts("chat-2", [WEB]).prefix).not.toBe(first.prefix);
    // Nothing of the conversation's id is in the name a model reads.
    expect(first.prefix).not.toContain("chat");
});

test("a turn with no conversation gets a key of its own each time", () => {
    const prefix = /^intentic_[0-9a-f]{8}_$/;
    const one = openCodeMounts(undefined, []).prefix;

    expect(one).toMatch(prefix);
    expect(openCodeMounts(undefined, []).prefix).not.toBe(one);
});

test("each server is remote, carries the turn's bearer and its call bound, and never starts an OAuth sign-in", () => {
    const mounts = openCodeMounts("chat-1", [WEB, CARD]);

    expect(mcpServersOf(mounts)).toEqual([
        {
            name: `${mounts.prefix}web`,
            config: {
                type: "remote",
                url: "http://127.0.0.1:7000/mcp/web",
                headers: { Authorization: "Bearer turn-bearer" },
                oauth: false,
                timeout: 120_000,
            },
        },
        // An unauthenticated endpoint with no bound of its own: no header, and OpenCode's default wait.
        { name: `${mounts.prefix}acme.billing`, config: { type: "remote", url: "https://mcp.example.com/billing", oauth: false } },
    ]);
});

// OpenCode keeps the last rule a tool matches, so the hiding rule comes first and the conversation's own after it.
test("a prompt hides every mounted server and then shows its own conversation's, in that order", () => {
    const mounts = openCodeMounts("chat-1", [WEB]);
    const rules = visibleToolsOf(mounts);

    expect(Object.entries(rules)).toEqual([
        ["intentic_*", false],
        [`${mounts.prefix}*`, true],
    ]);
});

test("a turn that mounts nothing still hides every other conversation's servers", () => {
    expect(visibleToolsOf(openCodeMounts("chat-1", []))).toEqual({ "intentic_*": false });
});

test("a mounted tool reads as the MCP call it is, and anything else passes through", () => {
    const mounts = openCodeMounts("chat-1", [WEB, CARD, { name: "web-archive", url: "http://127.0.0.1:7000/mcp/web-archive" }]);
    const nameOf = mcpToolNameOf(mounts);

    expect(nameOf(`${mounts.prefix}web_browser_navigate`)).toBe("mcp__web__browser_navigate");
    // OpenCode sanitizes the dot out of the key; the card still reads under the server's own name.
    expect(nameOf(`${mounts.prefix}acme_billing_list_invoices`)).toBe("mcp__acme.billing__list_invoices");
    // The longer server name wins over the shorter one it starts with.
    expect(nameOf(`${mounts.prefix}web-archive_fetch`)).toBe("mcp__web-archive__fetch");
    expect(nameOf("bash")).toBe("bash");
    // Another conversation's server is not this turn's to rename.
    expect(nameOf(`intentic_${keyOf("chat-2")}_web_browser_navigate`)).toBe(`intentic_${keyOf("chat-2")}_web_browser_navigate`);
});
