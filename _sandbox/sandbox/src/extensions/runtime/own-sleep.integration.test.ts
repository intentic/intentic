import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionSleepFrame, ExtensionSleepFrameSchema } from "@intentic/sandbox-contract/extension-protocol";
import { EXTENSION_TOKEN_HEADER } from "@intentic/sandbox-contract/headers";
import { unstubbed } from "@intentic/testing";
import { waitFor } from "@intentic/testing/bun";
import { Hono } from "hono";
import type { ExtensionGrant } from "../../auth/grants.js";
import { memoryDoorTokens } from "../../auth/tokens/door-tokens.js";
import { memorySecretVault } from "../../capabilities/capabilities-slice.testing.js";
import type { Services } from "../../composition.js";
import { testConfig } from "../../env.config.testing.js";
import { readWorkspaceFile } from "../../workspace/files/workspace-files.js";
import { beforeHostedSleep, setSleepBootFacts } from "./extension-sleep.js";
import { ownCaller } from "./own.routes.js";
import { createExtensionSleepDoors } from "./own-sleep.js";

// Hosted sleep's doors for an extension's own code (own-sleep.ts, extension-sleep.ts): a wake URL only for its own
// `wakes` routes and the same one every time, the before-sleep watch told and waited on, and what the boot follows.

const PUBLIC_URL = "https://sandbox-abcdef012345.sbx.test";
const MANIFEST = { version: "1.0.0", engines: { intentic: "^2.57.0" }, server: "dist/server.js" };
const GRANTS = new Map<string, ExtensionGrant>([
    ["chatty-token", { id: "acme.chatty", permissions: [] }],
    ["plain-token", { id: "acme.plain", permissions: [] }],
]);

const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "extension-sleep-"));
    const extensionsDir = join(root, "extensions");
    const write = (name: string, manifest: object): void => {
        mkdirSync(join(extensionsDir, name), { recursive: true });
        writeFileSync(join(extensionsDir, name, "intentic-extension.json"), JSON.stringify({ publisher: "acme", name, ...MANIFEST, ...manifest }));
    };
    write("chatty", {
        contributes: {
            listener: { provider: "chatty", events: [{ type: "message", label: "Messages" }], automation: { label: "Chatty", channel: { label: "Room", placeholder: "every room" }, starterPrompt: "A message." },
            },
            publicRoutes: [
                { path: "*/events", methods: ["POST"], automation: true, wakes: true },
                { path: "status", methods: ["GET"] },
            ],
        },
    });
    write("plain", {});
    const doorTokens = memoryDoorTokens();
    const services = unstubbed<Services>("services", {
        config: { ...testConfig, extensionsDir, historyRoot: join(root, "history"), sandbox: { ...testConfig.sandbox, publicUrl: PUBLIC_URL } },
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        files: unstubbed<Services["files"]>("files", { read: readWorkspaceFile }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [] }),
        extensionSecretVault: memorySecretVault(),
        extensionBackend: unstubbed<Services["extensionBackend"]>("extensionBackend", { verifyExtensionToken: (presented) => GRANTS.get(presented) }),
        logger: unstubbed<Services["logger"]>("logger", { warn: () => {}, info: () => {} }),
        doorTokens,
    });
    const sleep = createExtensionSleepDoors(services, (c) => ownCaller(services, c));
    const app = new Hono()
        .post("/extension/sleep/wake-url", sleep.wakeUrl)
        .get("/extension/sleep/boot", sleep.boot)
        .post("/extension/sleep/watch", sleep.watch)
        .post("/extension/sleep/ready", sleep.ready)
        .post("/extension/sleep/heard", sleep.heard);
    return { app, doorTokens };
};

const as = (token: string, body?: object): RequestInit => {
    const init: RequestInit = { method: "GET", headers: { [EXTENSION_TOKEN_HEADER]: token, "content-type": "application/json" } };
    if (body !== undefined) {
        init.method = "POST";
        init.body = JSON.stringify(body);
    }
    return init;
};

test("a wake URL names one of the caller's own `wakes` routes, keeps one secret for it, and refuses anything else", async () => {
    const { app, doorTokens } = setup();
    const asked = async (token: string, body: object) => app.request("/extension/sleep/wake-url", as(token, body));
    const first = await (await asked("chatty-token", { route: "*/events", automationId: "auto-1" })).json();
    const secret = await doorTokens.peek("wake", "/door/acme.chatty/auto-1/events");
    expect(first).toEqual({ url: `${PUBLIC_URL}/door/acme.chatty/auto-1/events?wake=${secret}` });
    expect(await (await asked("chatty-token", { route: "*/events", automationId: "auto-1" })).json()).toEqual(first);
    expect((await asked("chatty-token", { route: "status" })).status).toBe(400);
    expect((await asked("chatty-token", { route: "*/events" })).status).toBe(400);
    expect((await asked("plain-token", { route: "*/events", automationId: "auto-1" })).status).toBe(400);
    expect((await asked("nobody", { route: "*/events", automationId: "auto-1" })).status).toBe(403);
});

test("a sleep tells every watch and waits until each answered ready, or for nobody once they let go", async () => {
    const { app } = setup();
    const watch = new AbortController();
    const answer = await app.request("/extension/sleep/watch", { ...as("chatty-token", {}), signal: watch.signal });
    const frames: ExtensionSleepFrame[] = [];
    const reader = answer.body!.getReader();
    const decoder = new TextDecoder();
    void (async () => {
        let buffer = "";
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            const lines = (buffer + decoder.decode(chunk.value, { stream: true })).split("\n");
            buffer = lines.pop() ?? "";
            frames.push(...lines.filter((line) => line !== "").map((line) => ExtensionSleepFrameSchema.parse(JSON.parse(line))));
        }
    })().catch(() => undefined);
    await waitFor(() => expect(frames).toEqual([{ kind: "heartbeat" }]));
    const sleeping = beforeHostedSleep(5_000);
    await waitFor(() => expect(frames.map((frame) => frame.kind)).toEqual(["heartbeat", "sleep"]));
    const told = frames[1];
    const id = told?.kind === "sleep" ? told.id : "";
    // Another extension cannot answer a sleep it was not told.
    expect((await app.request("/extension/sleep/ready", as("plain-token", { id }))).status).toBe(200);
    expect((await app.request("/extension/sleep/ready", as("chatty-token", { id }))).status).toBe(200);
    expect(await sleeping).toEqual({ told: 1, answered: 1 });
    watch.abort();
    await reader.cancel();
    await waitFor(async () => expect(await beforeHostedSleep(50)).toEqual({ told: 0, answered: 0 }));
});

test("a watch that never answers is waited on only until the deadline", async () => {
    const { app } = setup();
    const watch = new AbortController();
    const answer = await app.request("/extension/sleep/watch", { ...as("chatty-token", {}), signal: watch.signal });
    expect(await beforeHostedSleep(100)).toEqual({ told: 1, answered: 0 });
    watch.abort();
    await answer.body?.cancel();
});

test("a boot says what it follows, from what is known until the platform has spoken", async () => {
    const { app } = setup();
    const spoken = Promise.withResolvers<{ afterSleep: boolean; requestWake: boolean }>();
    setSleepBootFacts({ afterSleep: true, requestWake: false }, () => spoken.promise);
    const asked = app.request("/extension/sleep/boot", as("chatty-token"));
    spoken.resolve({ afterSleep: true, requestWake: true });
    expect(await (await asked).json()).toEqual({ afterSleep: true, requestWake: true });
    expect((await app.request("/extension/sleep/boot", as("nobody"))).status).toBe(403);
});

test("what the platform heard while it slept is nothing on a sandbox it does not host, and only for a known extension", async () => {
    const { app } = setup();
    expect(testConfig.sandbox.vm).toBe(false);
    expect(await (await app.request("/extension/sleep/heard", as("chatty-token", {}))).json()).toEqual({ heard: [] });
    expect((await app.request("/extension/sleep/heard", as("nobody", {}))).status).toBe(403);
});
