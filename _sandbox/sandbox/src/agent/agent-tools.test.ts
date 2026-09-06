import { expect, test } from "vitest";
import { internalTools, mcpServersOf } from "./agent-tools.js";

const encode = (tools: unknown): string => Buffer.from(JSON.stringify(tools)).toString("base64");

test("internalTools decodes the base64 JSON the provider forwards; absent/empty → none", () => {
    expect(internalTools(undefined)).toEqual([]);
    expect(internalTools("")).toEqual([]);
    expect(internalTools(encode([{ name: "obs", url: "https://signoz.example.com/mcp", token: "tok" }]))).toEqual([
        { name: "obs", url: "https://signoz.example.com/mcp", token: "tok" },
    ]);
});

test("internalTools rejects a malformed payload (a provisioning bug, not silently dropped)", () => {
    expect(() => internalTools(encode([{ url: "https://x/mcp" }]))).toThrow();
});

// Deferred behind tool search (no `alwaysLoad`): pinned, a connected computer's 25 schemas rode every call
// and were reached in 5% of sessions; the device skill names the tools and how to load them instead.
test("mcpServersOf builds a remote http server with bearer auth, deferred behind tool search", () => {
    const servers = mcpServersOf([{ name: "obs", url: "https://signoz.example.com/mcp", token: "tok" }]);
    expect(servers).toEqual({
        obs: { type: "http", url: "https://signoz.example.com/mcp", headers: { Authorization: "Bearer tok" } },
    });
    expect(servers["obs"]).not.toHaveProperty("alwaysLoad");
});

test("a tool without a token carries no Authorization header", () => {
    expect(mcpServersOf([{ name: "pub", url: "https://pub.example.com/mcp" }])).toEqual({
        pub: { type: "http", url: "https://pub.example.com/mcp" },
    });
});

test("a later same-named tool overrides an earlier one (external overrides internal default)", () => {
    const servers = mcpServersOf([
        { name: "obs", url: "https://internal/mcp", token: "a" },
        { name: "obs", url: "https://external/mcp", token: "b" },
    ]);
    expect(servers["obs"]).toEqual({ type: "http", url: "https://external/mcp", headers: { Authorization: "Bearer b" } });
});

test("no tools → an empty server map", () => {
    expect(mcpServersOf([])).toEqual({});
});
