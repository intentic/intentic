import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserSessionName } from "@intentic/sandbox-contract/session-names";
import { expect, test } from "vitest";
import {
    browserSessionHooks,
    browserServerOfTool,
    closeBrowserSession,
    browserSessionContext,
    listBrowserSessions,
} from "./browser-sessions.js";
import { browserServersOf } from "./browser-tools.js";
import { startScreencast } from "./screencast.js";

test("a browser tool's server and session name are derived the same way everywhere", () => {
    expect(browserServerOfTool("mcp__web__browser_navigate")).toBe("web");
    expect(browserServerOfTool("mcp__reddit-main__browser_click")).toBe("reddit-main");
    expect(browserServerOfTool("mcp__hashline__hashline_edit")).toBeUndefined();
    expect(browserServerOfTool("Bash")).toBeUndefined();

    // Eight characters of the SDK session id — the same slice agentSessionName takes, so a conversation's
    // shell and its browser are visibly the pair they are.
    expect(browserSessionName("abcd1234-5678-90ab-cdef-1234567890ab")).toBe("browser-abcd1234");
    expect(browserSessionName("!!!")).toBeUndefined();
});

/* THE SEAM NOTHING ELSE COVERS: that the browser the agent drives and the browser the daemon watches are the
 * same browser. Every part of it is real — the MCP spec this daemon builds, a Chromium it launches itself, the
 * PreToolUse hook the SDK would fire, and a CDP attach over the debugging port that spec asked for. Mocking any
 * of it would only prove the mock.
 *
 * The page is served from loopback so the test needs no network, and the whole thing stands down where the
 * image has no Chromium (a CI host that skipped the browser install), exactly as browser-tools.test.ts does. */
const SESSION_ID = "e2e11111-2222";
const SESSION = "browser-e2e11111";

test("the agent's browser is listed, watchable, and closable while the MCP drives it", { timeout: 120_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "browser-sessions-"));
    const { servers, ports } = await browserServersOf([], root);
    const web = servers["web"] as { command: string; args: string[]; env: Record<string, string> } | undefined;
    const port = ports["web"];
    if (web === undefined || port === undefined) {
        return; // no Chromium on disk — nothing to drive
    }

    const site = createServer((_request, response) => response.end("<title>Probe Page</title><h1>hello</h1>"));
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", () => resolve()));
    const url = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;

    const child = spawn(web.command, web.args, { env: web.env, stdio: ["pipe", "pipe", "pipe"] });
    // Minimal stdio JSON-RPC client: the MCP answers one line per message, correlated by id.
    let buffered = "";
    const pending = new Map<number, (message: unknown) => void>();
    child.stdout.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        let end: number;
        while ((end = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, end);
            buffered = buffered.slice(end + 1);
            if (line.trim() === "") {
                continue;
            }
            const message = JSON.parse(line) as { id?: number };
            if (message.id !== undefined) {
                pending.get(message.id)?.(message);
                pending.delete(message.id);
            }
        }
    });
    let nextId = 1;
    const call = (method: string, params: unknown): Promise<{ result?: { isError?: boolean } }> =>
        new Promise((resolve) => {
            const id = nextId++;
            pending.set(id, resolve as (message: unknown) => void);
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });

    try {
        await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

        // What the SDK does: the PreToolUse hook fires with the tool name and session id, THEN the tool runs.
        const hook = browserSessionHooks(ports).PreToolUse?.[0]?.hooks[0];
        expect(hook).toBeDefined();
        const input = { hook_event_name: "PreToolUse", tool_name: "mcp__web__browser_navigate", session_id: SESSION_ID, tool_input: { url } };
        await hook?.(input as never, "t1", { signal: new AbortController().signal });

        // The session exists from the hook alone — before Chromium has painted anything — which is what puts it
        // on the rail at the start of a slow first navigation rather than after it.
        expect(listBrowserSessions().map((session) => session.name)).toContain(SESSION);

        const navigate = await call("tools/call", { name: "browser_navigate", arguments: { url } });
        expect(navigate.result?.isError ?? false).toBe(false);

        // The daemon's own attach sees the page the MCP created, and can stream it.
        const context = await browserSessionContext(SESSION);
        expect(context).toBeDefined();
        let frames = 0;
        const screencast = await startScreencast(context!, () => {
            frames += 1;
        });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await screencast.stop();

        const listed = listBrowserSessions().find((session) => session.name === SESSION);
        expect(listed?.running).toBe(true);
        // The page's own account of itself, which is what the tab pill and its tooltip say.
        expect(listed?.label).toBe("Probe Page");
        expect(listed?.url).toBe(url);
        expect(frames).toBeGreaterThan(0);

        // The kill route's half: closing the browser ends the session, and the row stays readable afterwards.
        await closeBrowserSession(SESSION);
        expect(listBrowserSessions().find((session) => session.name === SESSION)?.running).toBe(false);
    } finally {
        child.kill();
        site.close();
    }
});
