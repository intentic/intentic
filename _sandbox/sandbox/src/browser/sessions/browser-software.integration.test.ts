import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { RpcMessage } from "../../agent/tools/turn-mounts.js";
import { displayAnswers, displayOf, releaseDisplay } from "../cast/display.js";
import { type BrowserRouter, createBrowserRouter } from "../tools/browser-router.js";
import { ANONYMOUS_BROWSER_SERVER, browserToolSchemas, prepareBrowserOwner } from "../tools/browser-tools.js";

// The credential-free browser end to end, through the real @playwright/mcp backend: it reports the SwiftShader it
// renders on (no stealth GPU), offers WebGPU on a SwiftShader fallback adapter, and keeps working after browser_close
// once the session's display release has run (it used to relaunch into a dead X server: "Missing X server").
// Needs Chromium and Xvfb; skipped without them.

const ResultSchema = z.object({ content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })), isError: z.boolean().optional() });

const textOf = (answer: RpcMessage | undefined): string => {
    const result = ResultSchema.parse(answer?.result);
    return result.content.map((block) => block.text ?? `[${block.type}]`).join("\n");
};

let server: Server | undefined;
let router: BrowserRouter | undefined;

// The display goes once the backend's process has, which is after close() returns: waited for, so no X server is left.
afterAll(async () => {
    const display = displayOf(ANONYMOUS_BROWSER_SERVER);
    router?.close();
    server?.close();
    releaseDisplay(ANONYMOUS_BROWSER_SERVER);
    if (display === undefined) {
        return;
    }
    for (let waited = 0; (await displayAnswers(display)) && waited < 5_000; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
});

const ready = async (): Promise<boolean> => {
    const { chromium } = await import("playwright");
    return existsSync(chromium.executablePath()) && existsSync("/usr/bin/Xvfb");
};

test("the web browser renders WebGL and WebGPU on SwiftShader, says so, and survives browser_close", async () => {
    if (!(await ready())) {
        return;
    }
    server = createServer((_request, response) => {
        response.setHeader("content-type", "text/html");
        response.end("<!doctype html><title>software</title><canvas></canvas>");
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = z.object({ port: z.number() }).parse(server.address());
    const root = mkdtempSync(join(tmpdir(), "browser-software-"));
    router = createBrowserRouter(
        { accounts: {}, owners: { [ANONYMOUS_BROWSER_SERVER]: { port: 0 } }, soleOwner: ANONYMOUS_BROWSER_SERVER, backendEnv: {} },
        { toolSchemas: browserToolSchemas, prepare: (owner) => prepareBrowserOwner([], root, owner, 0) },
    );
    let id = 0;
    const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
        id += 1;
        return textOf(await router?.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }));
    };
    await router.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });

    const probe = `async () => {
        const gl = document.createElement("canvas").getContext("webgl2");
        const info = gl.getExtension("WEBGL_debug_renderer_info");
        const adapter = await navigator.gpu?.requestAdapter();
        return { renderer: gl.getParameter(info.UNMASKED_RENDERER_WEBGL), webgpu: adapter ? adapter.info.architecture : null };
    }`;
    expect(await call("browser_navigate", { url: `http://localhost:${port}/` })).toContain("software");
    const first = await call("browser_evaluate", { function: probe });
    expect(first).toContain("SwiftShader");
    expect(first).not.toMatch(/NVIDIA|GeForce|Radeon|Intel/);
    expect(first).toContain('"webgpu": "swiftshader"');

    expect(await call("browser_close", {})).not.toContain("Error");
    // What browser-sessions.ts does when the closed Chromium's CDP connection drops: the backend still holds it.
    releaseDisplay(ANONYMOUS_BROWSER_SERVER);
    const again = await call("browser_navigate", { url: `http://localhost:${port}/` });
    expect(again).not.toContain("Missing X server");
    expect(again).toContain("software");
}, 120_000);
