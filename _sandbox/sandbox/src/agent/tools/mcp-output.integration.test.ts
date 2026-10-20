import { Hono } from "hono";
import { unstubbed } from "@intentic/testing";
import { createTurnMounts } from "./turn-mounts.js";
import { createTurnMountRoute, type MountEndpoints } from "./turn-mounts.routes.js";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { cleanMcpResult, mcpHeldOut, type McpOutputOptions } from "../../guard/mcp-output.js";
import { outsideResultHooks, sealedDoor } from "../../guard/outside-results.js";
import { boundChildReport } from "../subagents/waiting/subagent-wait.js";
import { redactionHooks } from "./agent-redaction.js";

const dirs: string[] = [];
const options = (): McpOutputOptions => {
    const logsDir = mkdtempSync(join(tmpdir(), "mcp-output-"));
    dirs.push(logsDir);
    return { logsDir, name: () => "test", conversationId: "conversation" };
};
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});
const result = (text: string) => ({ content: [{ type: "text", text }] });
// SAFETY: callers supply MCP text fixtures or the cleaner, which preserves their content envelope.
const textOf = (value: unknown): string => (value as ReturnType<typeof result>).content[0]!.text;
const long = Array.from({ length: 800 }, (_, i) => `line ${i}: useful text for the model`).join("\n");

test("strict threshold; only text changes, with original retention and accounted footer", () => {
    const opts = options();
    const small = result("x".repeat(16_384));
    expect(cleanMcpResult("mcp__diagnostics__logs", small, opts)).toBe(small);
    const image = { type: "image", data: long, mimeType: "image/png" };
    const resource = { type: "resource", resource: { text: long } };
    const input = { content: [...result(long).content, image, resource], isError: true };
    // SAFETY: the cleaner preserves non-text parts and result metadata.
    const output = cleanMcpResult("mcp__diagnostics__logs", input, opts) as typeof input;
    expect(output.content[1]).toBe(image);
    expect(output.content[2]).toBe(resource);
    expect(output.isError).toBe(true);
    const path = join(opts.logsDir, "raw-output", "mcp-test.log");
    expect(readFileSync(path, "utf8")).toBe(long);
    expect(textOf(output)).toContain(`full: retrieve-output ${path} [pattern]`);
    expect(textOf(output)).toContain("line 0:");
    expect(textOf(output)).toContain("line 799:");
    expect(textOf(output)).not.toContain("line 400:");
    const stat = JSON.parse(readFileSync(join(opts.logsDir, "filter-stats.jsonl"), "utf8"));
    expect(stat.stageBytes).toEqual({ mcp: long.length - textOf(output).length });
    expect(stat.tool).toBe("mcp__diagnostics__logs");
});

test("off, holdout and structural tools return the same reference", () => {
    const opts = options();
    const input = result(long);
    for (const tool of ["Bash", "mcp__ui__show_page", "mcp__watch__start", "mcp__code__run", "mcp__secrets__list", "mcp__subagents__wait"]) {
        expect(cleanMcpResult(tool, input, opts)).toBe(input);
    }
    expect(cleanMcpResult("mcp__diagnostics__logs", input, { ...opts, spec: "off" })).toBe(input);
    expect(cleanMcpResult("mcp__diagnostics__logs", input, { ...opts, holdout: 1 })).toBe(input);
    expect(mcpHeldOut({ ...opts, holdout: 0 })).toBe(false);
    expect(mcpHeldOut({ ...opts, holdout: 1 })).toBe(true);
    expect(readdirSync(opts.logsDir)).toEqual(["filter-stats.jsonl"]);
    expect(JSON.parse(readFileSync(join(opts.logsDir, "filter-stats.jsonl"), "utf8")).heldOut).toBe(true);
});

test("snapshots keep refs at both ends and name browser_find", () => {
    const opts = options();
    const tree = Array.from({ length: 1800 }, (_, i) => `  - button "Open item ${i}" [ref=e${i}]`).join("\n");
    const under = result(tree.slice(0, 49_152));
    expect(cleanMcpResult("mcp__web__browser_snapshot", under, opts)).toBe(under);
    const output = textOf(cleanMcpResult("mcp__browser__browser_click", result(tree), opts));
    expect(output).toContain("[ref=e0]");
    expect(output).toContain("[ref=e1799]");
    expect(output).not.toContain("[ref=e900]");
    expect(output).toContain("browser_find");
    expect(readFileSync(join(opts.logsDir, "raw-output", "mcp-test.log"), "utf8")).toBe(tree);
});

test("omitted errors survive; failed storage leaves the original", () => {
    const opts = options();
    const input = result(long.replace("line 400:", "fatal error at line 400:"));
    expect(textOf(cleanMcpResult("mcp__device__run_command", input, opts))).toContain("fatal error at line 400:");
    expect(cleanMcpResult("mcp__device__run_command", input, { ...opts, logsDir: "/dev/null/cannot-write" })).toBe(input);
});

test("PostToolUse and sealedDoor apply the same rule without changing the input", async () => {
    const opts = options();
    const input = result(long);
    const hook = outsideResultHooks(() => {}, opts).PostToolUse![0]!.hooks[0]!;
    // SAFETY: the fixture supplies the PostToolUse fields this hook reads; SDK-only session metadata is unused.
    const hooked = await hook(
        { hook_event_name: "PostToolUse", tool_name: "mcp__diagnostics__logs", tool_input: {}, tool_response: input, tool_use_id: "t" } as HookInput,
        "t",
        { signal: new AbortController().signal },
    );
    const door = sealedDoor({ handle: async () => ({ result: input }), close: () => {} }, "diagnostics", () => {}, opts);
    const answered = await door.handle({ method: "tools/call", params: { name: "logs" } });
    // Envelope IDs are intentionally fresh on each boundary; all other content must match exactly.
    const normalize = (value: unknown) => JSON.stringify(value).replaceAll(/id=\\"[a-f0-9]+\\"/g, 'id=\\"nonce\\"');
    expect(normalize(hooked)).toBe(normalize({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: answered!.result } }));
    expect(input).toEqual(result(long));
});

test("masking composes before cleaning and retention", async () => {
    const opts = options();
    const raw = `${long}\nprivate-credential-value`;
    const hook = outsideResultHooks(
        () => {},
        opts,
        redactionHooks(async () => [{ name: "test", value: "private-credential-value", source: "sandbox" }]).PostToolUse![0]!.hooks[0],
    ).PostToolUse![0]!.hooks[0]!;
    // SAFETY: the fixture supplies the PostToolUse fields this hook reads; SDK-only session metadata is unused.
    const output = await hook(
        {
            hook_event_name: "PostToolUse",
            tool_name: "mcp__diagnostics__logs",
            tool_input: {},
            tool_response: result(raw),
            tool_use_id: "t",
        } as HookInput,
        "t",
        { signal: new AbortController().signal },
    );
    expect(JSON.stringify(output)).toContain("retrieve-output");
    expect(JSON.stringify(output)).not.toContain("private-credential-value");
    expect(readFileSync(join(opts.logsDir, "raw-output", "mcp-test.log"), "utf8")).toBe(`${long}\n` + `{{` + `secret:test}}`);
});

test("child reports have a separate generous bound and retrievable file", () => {
    const opts = options();
    expect(boundChildReport(undefined, opts)).toBeUndefined();
    expect(boundChildReport("x".repeat(12_000), opts)).toBe("x".repeat(12_000));
    const output = boundChildReport(long, opts)!;
    expect(output.length).toBeLessThan(12_000);
    expect(output).toStartWith(long.slice(0, 4000));
    expect(output).toContain(long.slice(-7000));
    expect(readFileSync(join(opts.logsDir, "raw-output", "mcp-test.log"), "utf8")).toBe(long);
});

test("the HTTP bridge cleans browser/device results once, leaving Claude's copy for its hook", async () => {
    const opts = options();
    for (const cleanOutput of [true, false]) {
        const mounts = createTurnMounts({ baseUrl: () => "http://localhost/mcp" });
        const lease = mounts.lease("conversation", { cleanOutput });
        const mounted = lease.open({ name: "device", target: { kind: "device", id: "machine" } });
        const app = new Hono().all(
            "/mcp/:mount",
            createTurnMountRoute(
                mounts,
                unstubbed<MountEndpoints>("endpoints", {
                    device: async () => ({ result: result(long) }),
                }),
                async (tool, value) => cleanMcpResult(tool, value, opts),
            ),
        );
        const response = await app.request("http://localhost/mcp/device", {
            method: "POST",
            headers: { authorization: `Bearer ${mounted.token}`, "content-type": "application/json" },
            body: JSON.stringify({ method: "tools/call", params: { name: "run_command" } }),
        });
        // SAFETY: the fixture endpoint above returns a JSON-RPC result containing the text fixture.
        const payload = (await response.json()) as { result: unknown };
        expect(textOf(payload.result)).toBe(cleanOutput ? textOf(cleanMcpResult("mcp__device__run_command", result(long), opts)) : long);
        lease.release();
    }
});

test("MCP retention saves a complete original beyond the shell per-file ceiling", () => {
    const opts = options();
    const original = `start\n${"x".repeat(2_100_000)}\nend`;
    const output = cleanMcpResult("mcp__diagnostics__logs", result(original), opts);
    expect(textOf(output)).toContain("retrieve-output");
    expect(readFileSync(join(opts.logsDir, "raw-output", "mcp-test.log"), "utf8")).toBe(original);
});
