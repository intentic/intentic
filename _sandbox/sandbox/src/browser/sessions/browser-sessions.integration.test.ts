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
    browserSessionPage,
    listBrowserSessions,
} from "./browser-sessions.js";
import { browserServersOf } from "../tools/browser-tools.js";
import { startScreencast } from "../cast/screencast.js";

test("a browser tool's server and session name are derived the same way everywhere", () => {
    expect(browserServerOfTool("mcp__web__browser_navigate")).toBe("web");
    expect(browserServerOfTool("mcp__reddit-main__browser_click")).toBe("reddit-main");
    expect(browserServerOfTool("mcp__hashline__hashline_edit")).toBeUndefined();
    expect(browserServerOfTool("Bash")).toBeUndefined();

    // Eight chars of the id, the same slice agentSessionName takes.
    expect(browserSessionName("abcd1234-5678-90ab-cdef-1234567890ab")).toBe("browser-abcd1234");
    expect(browserSessionName("!!!")).toBeUndefined();
});

// Exercises the real seam: an actual MCP server, real Chromium, real CDP attach, no mocks.
// Skips when the image has no Chromium installed.
const SESSION_ID = "e2e11111-2222";
const SESSION = "browser-e2e11111";

// Polls for a real event instead of sleeping a guess; capped so a real regression still fails on the assertion instead
// of hanging to the timeout.
const settle = async (until: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 200 && !until(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};

const pagesOf = (): number => listBrowserSessions().find((session) => session.name === SESSION)?.pages.length ?? 0;

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
    // Newline-delimited JSON-RPC over stdio, correlated by id.
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

        // PreToolUse fires with the tool name and session id before the tool runs.
        const hook = browserSessionHooks(ports).PreToolUse?.[0]?.hooks[0];
        const input = { hook_event_name: "PreToolUse", tool_name: "mcp__web__browser_navigate", session_id: SESSION_ID, tool_input: { url } };
        await hook?.(input as never, "t1", { signal: new AbortController().signal });

        // Session exists from the hook alone, before Chromium paints anything.
        expect(listBrowserSessions().map((session) => session.name)).toContain(SESSION);

        const navigate = await call("tools/call", { name: "browser_navigate", arguments: { url } });
        expect(navigate.result?.isError ?? false).toBe(false);

        // Daemon's own attach sees the page the MCP created.
        const context = await browserSessionContext(SESSION);
        expect(context).toEqual(expect.any(Object));
        const formats: string[] = [];
        const screencast = await startScreencast(context!, (frame) => {
            formats.push(frame.format);
        });
        await settle(() => formats.includes("jpeg") && formats.includes("webp"));
        await screencast.stop();

        const listed = listBrowserSessions().find((session) => session.name === SESSION);
        expect(listed?.running).toBe(true);
        expect(listed?.label).toBe("Probe Page");
        expect(listed?.server).toBe("web");
        // jpeg frames while painting; webp only after it settles into a high-res still.
        expect(formats).toContain("jpeg");
        expect(formats).toContain("webp");

        expect(listed?.pages).toHaveLength(1);
        const first = listed?.pages[0];
        expect(first?.url).toBe(url);
        expect(first?.title).toBe("Probe Page");
        expect(first?.active).toBe(true);

        // New tab becomes active; ids stay distinct across a relist even for the same url.
        const opened = await call("tools/call", { name: "browser_tabs", arguments: { action: "new" } });
        expect(opened.result?.isError ?? false).toBe(false);
        await settle(() => pagesOf() >= 2);
        const twoTabs = listBrowserSessions().find((session) => session.name === SESSION);
        expect(twoTabs?.pages.length).toBeGreaterThanOrEqual(2);
        expect(new Set(twoTabs?.pages.map((page) => page.id)).size).toBe(twoTabs?.pages.length);
        expect(twoTabs?.pages.filter((page) => page.active)).toHaveLength(1);

        // list to bind round trip (id to Page) is the tab strip's whole contract.
        for (const page of twoTabs?.pages ?? []) {
            expect(browserSessionPage(SESSION, page.id)).toEqual(expect.any(Object));
        }
        expect(browserSessionPage(SESSION, "p-nope")).toBeUndefined();

        // A tab the agent opens next must not steal the picture from one the owner pinned.
        const pinTarget = browserSessionPage(SESSION, twoTabs?.pages[0]?.id ?? "");
        expect(pinTarget).toEqual(expect.any(Object));
        const pinnedCast = await startScreencast(context!, () => {});
        try {
            await pinnedCast.bind(pinTarget!, true);
            const boundToFirst = pinnedCast.attached();
            const third = await call("tools/call", { name: "browser_tabs", arguments: { action: "new" } });
            expect(third.result?.isError ?? false).toBe(false);
            // Waits for the third tab to actually land before checking the pin held.
            await settle(() => pagesOf() >= 3);
            expect(pagesOf()).toBeGreaterThanOrEqual(3);
            // attached() equality here means the same CDP session; the stream didn't move.
            expect(pinnedCast.attached()).toBe(boundToFirst);
        } finally {
            await pinnedCast.stop();
        }

        // Paused must hold the binding but emit nothing while backgrounded; this nav is the session's final page below.
        let whilePaused = 0;
        const pausedCast = await startScreencast(context!, () => {
            whilePaused += 1;
        });
        try {
            await pausedCast.setPaused(true);
            whilePaused = 0;
            const repaint = await call("tools/call", { name: "browser_navigate", arguments: { url } });
            expect(repaint.result?.isError ?? false).toBe(false);
            // Sleep, not poll: there's no arrival to wait for, and a slow machine sending fewer frames still satisfies
            // zero.
            await new Promise((resolve) => setTimeout(resolve, 1000));
            expect(whilePaused).toBe(0);
            // Unpausing needs no reconnect or rebind; the next frame just arrives.
            await pausedCast.setPaused(false);
            await settle(() => whilePaused > 0);
            expect(whilePaused).toBeGreaterThan(0);
        } finally {
            await pausedCast.stop();
        }

        // Closing ends the session but keeps its row, including where the agent went, listable afterward.
        await closeBrowserSession(SESSION);
        const dead = listBrowserSessions().find((session) => session.name === SESSION);
        expect(dead?.running).toBe(false);
        expect(dead?.pages.length).toBeGreaterThanOrEqual(2);
        expect(dead?.finishedAt).toBeGreaterThan(0);
        // A finished session's label is the last page it drove, not the active slot every closing page walks back.
        expect(dead?.label).toBe("Probe Page");
        expect(dead?.pages.filter((page) => page.active)).toHaveLength(1);
        // Nothing to bind once the Chromium is gone; the handles it still lists are dead.
        expect(browserSessionPage(SESSION, dead?.pages[0]?.id ?? "")).toBeUndefined();
    } finally {
        child.kill();
        site.close();
    }
});
