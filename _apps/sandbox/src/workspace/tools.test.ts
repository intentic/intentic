import { expect, test } from "vitest";
import { internalTools, mcpServersOf } from "./tools.js";

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

test("mcpServersOf builds a remote http server with bearer auth and alwaysLoad", () => {
    expect(mcpServersOf([{ name: "obs", url: "https://signoz.example.com/mcp", token: "tok" }])).toEqual({
        obs: { type: "http", url: "https://signoz.example.com/mcp", alwaysLoad: true, headers: { Authorization: "Bearer tok" } },
    });
});

test("a tool without a token carries no Authorization header", () => {
    expect(mcpServersOf([{ name: "pub", url: "https://pub.example.com/mcp" }])).toEqual({
        pub: { type: "http", url: "https://pub.example.com/mcp", alwaysLoad: true },
    });
});

test("a later same-named tool overrides an earlier one (external overrides internal default)", () => {
    const servers = mcpServersOf([
        { name: "obs", url: "https://internal/mcp", token: "a" },
        { name: "obs", url: "https://external/mcp", token: "b" },
    ]);
    expect(servers["obs"]).toEqual({ type: "http", url: "https://external/mcp", alwaysLoad: true, headers: { Authorization: "Bearer b" } });
});

test("no tools → an empty server map", () => {
    expect(mcpServersOf([])).toEqual({});
});
