import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import { PowChallengeSchema } from "@intentic/sandbox-contract/schemas/automations";
import { z } from "zod";
import { createApp } from "../../app.js";
import type { AutomationRecord } from "../../automations/automations-store.js";
import { memoryAutomationsStore } from "../../automations/automations-slice.testing.js";
import { approveExtension } from "../../capabilities/extension-inventory/extension-approvals.js";
import { workspaceExtensionsRoot } from "../../capabilities/extension-dirs.js";
import type { Services } from "../../composition.js";
import { testConfig } from "../../env.config.testing.js";
import { services } from "../../harness/route-services.testing.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { createExtensionBackend, type ExtensionBackend } from "./backend-supervisor.js";

// The bug intake's public paths from before it moved onto the issues extension's door (2026-11-26), as a customer's page
// or an app built against the old SDK still calls them: each must reach the extension's own route through the door's
// protections, with the key and the proof of work the old SDK put in the body moved to where the door reads them, and
// with the extension off, say so rather than answer as if nothing were there.

const started: ExtensionBackend[] = [];
afterEach(() => {
    for (const backend of started.splice(0)) {
        backend.stop();
    }
});

// A stand-in for the issues extension's backend: records every public call (its path under /door/<id>) with what the door
// said it checked.
const SERVER = `const heard = [];
export const activateServer = (api) => {
    api.routes.mount(async (request) => (new URL(request.url).pathname === "/heard" ? Response.json(heard) : undefined));
    api.publicRoutes.serve(async (request, verified) => {
        const url = new URL(request.url);
        heard.push({ path: url.pathname, query: url.search, verified, body: request.method === "GET" ? null : await request.text() });
        return url.pathname.endsWith("/sdk.js") ? new Response("/* the reporter */", { headers: { "content-type": "application/javascript" } }) : Response.json({ ok: true, id: "4f3a" });
    });
};
`;

const MANIFEST = {
    publisher: "intentic",
    name: "issues",
    version: "2.0.0",
    engines: { intentic: "^2.53.0" },
    server: "server.js",
    contributes: {
        listener: {
            provider: "issues",
            strangers: "report",
            events: [{ type: "crash", label: "Crashes" }],
            automation: { label: "Bug reports", channel: { label: "Site", placeholder: "every site" }, starterPrompt: "A bug arrived." },
        },
        publicRoutes: [
            { path: "sdk.js", methods: ["GET"] },
            { path: "*/config", methods: ["GET"], automation: true },
            { path: "*/report", methods: ["POST"], automation: true, origins: "listed", key: true },
            { path: "*/written", methods: ["POST"], automation: true, origins: "listed", key: true, proofOfWork: true },
        ],
    },
};

const SITE = "https://shop.example";

const intake: AutomationRecord = {
    id: "bugs",
    trigger: { kind: "listener", provider: "issues", allowedOrigins: [SITE] },
    prompt: "Fix it.",
    models: [{ provider: "claude", model: "claude-sonnet-4-6" }],
    enabled: true,
    runs: [],
};

const harness = async (installed: boolean) => {
    const root = mkdtempSync(join(tmpdir(), "moved-doors-"));
    const history = `${root}-history`;
    if (installed) {
        const dir = join(workspaceExtensionsRoot(root), "issues");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "intentic-extension.json"), JSON.stringify(MANIFEST));
        await writeFile(join(dir, "server.js"), SERVER);
        await approveExtension(history, "intentic.issues", ExtensionManifestSchema.parse(MANIFEST));
    }
    const quiet = unstubbed<Services["logger"]>("logger", { info: () => undefined, warn: () => undefined, error: console.error });
    const backend = createExtensionBackend(() => svc, 0, quiet);
    started.push(backend);
    const svc = services({
        workspace: workspacePaths(root),
        config: { ...testConfig, extensionsDir: "", historyRoot: history },
        extensionBackend: backend,
        automations: memoryAutomationsStore([intake]),
    });
    await backend.start();
    return { svc, app: createApp(svc) };
};

const HeardSchema = z.array(z.object({ path: z.string(), query: z.string(), verified: z.record(z.string(), z.unknown()), body: z.string().nullable() }));
const heard = async (app: ReturnType<typeof createApp>) => HeardSchema.parse(await (await app.request("http://sandbox.test/x/intentic.issues/heard")).json());

const REPORT = { kind: "crash", message: "TypeError: x is not a function" };

test("the old script and settings paths reach the extension's own routes, a browser's origin carried", async () => {
    const { app } = await harness(true);
    const sdk = await app.request("http://sandbox.test/intake/sdk.js");
    expect(sdk.status).toBe(200);
    expect(await sdk.text()).toBe("/* the reporter */");
    expect((await app.request("http://sandbox.test/intake/bugs/config", { headers: { origin: SITE } })).status).toBe(200);
    expect((await heard(app)).map((call) => [call.path, call.verified["route"], call.verified["origin"] ?? null])).toEqual([
        ["/sdk.js", "sdk.js", null],
        ["/bugs/config", "*/config", SITE],
    ]);
});

test("an old SDK's report reaches the report route, its key moved out of the body to where the door checks it", async () => {
    const { svc, app } = await harness(true);
    const key = await svc.doorTokens.ensure("intake", "bugs");
    const post = (body: object, headers: Record<string, string> = {}) =>
        app.request("http://sandbox.test/intake/bugs/report", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

    // An app with no origin and a wrong key, and a browser off the list, are refused by the door before the backend.
    expect((await post({ report: REPORT, clientId: "app-1", key: "ik_guessed" })).status).toBe(403);
    expect((await post({ report: REPORT, clientId: "tab-1" }, { origin: "https://evil.example" })).status).toBe(403);
    expect(await heard(app)).toEqual([]);

    expect(await (await post({ report: REPORT, clientId: "app-1", key })).json()).toEqual({ ok: true, id: "4f3a" });
    expect((await post({ report: REPORT, clientId: "tab-1" }, { origin: SITE })).status).toBe(200);
    const calls = await heard(app);
    expect(calls.map((call) => [call.path, call.verified["keyed"] ?? false, call.verified["origin"] ?? null])).toEqual([
        ["/bugs/report", true, null],
        ["/bugs/report", false, SITE],
    ]);
    // Neither the key nor anything the door reads reaches the backend: the body is the report and the browser's id.
    expect(calls[0]?.query).toBe("");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ report: REPORT, clientId: "app-1" });
});

test("an old SDK's written report with its proof reaches the route that checks one, the proof bound to its browser", async () => {
    const { app } = await harness(true);
    const challenge = PowChallengeSchema.parse(await (await app.request("http://sandbox.test/intake/bugs/challenge?client=tab-1", { headers: { origin: SITE } })).json());
    let nonce = 0;
    while (!createHash("sha256").update(`${challenge.salt}:${nonce}`).digest().subarray(0, 2).every((byte) => byte === 0)) {
        nonce += 1;
    }
    const written = { report: { kind: "report", message: "the checkout froze" }, powNonce: `${challenge.salt}:${nonce}` };
    const post = (clientId: string) =>
        app.request("http://sandbox.test/intake/bugs/report", { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify({ ...written, clientId }) });
    // Solved for one browser, sent by another.
    expect((await post("tab-2")).status).toBe(403);
    expect((await post("tab-1")).status).toBe(200);
    const calls = await heard(app);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: "/bugs/written", verified: { route: "*/written", proofOfWork: { caller: "tab-1" } } });
    expect(JSON.parse(calls[0]?.body ?? "{}")).not.toHaveProperty("powNonce");
});

test("with the issues extension not on, the old paths say so where the page's owner looks", async () => {
    const { app } = await harness(false);
    const sdk = await app.request("http://sandbox.test/intake/sdk.js");
    expect(sdk.status).toBe(404);
    expect(sdk.headers.get("content-type")).toContain("javascript");
    expect(await sdk.text()).toContain("console.error(");
    const report = await app.request("http://sandbox.test/intake/bugs/report", {
        method: "POST",
        headers: { "content-type": "application/json", origin: SITE },
        body: JSON.stringify({ report: REPORT, clientId: "tab-1" }),
    });
    expect(report.status).toBe(404);
    expect(await report.json()).toEqual({ error: "bug reports now arrive through the Issues extension, which this sandbox does not have switched on" });
});

// The Visitor chat's public paths from before it moved onto the visitor-chat extension's door (2026-11-26): a snippet in a
// customer's page loads /webchat/widget.js for good, and a widget a page loaded before the update still calls the rest.
// A stand-in for the extension's backend records each public call and answers a message as a stream, as the real one
// streams the agent's answer.
const CHAT_SERVER = `const heard = [];
export const activateServer = (api) => {
    api.routes.mount(async (request) => (new URL(request.url).pathname === "/heard" ? Response.json(heard) : undefined));
    api.publicRoutes.serve(async (request, verified) => {
        const url = new URL(request.url);
        heard.push({ path: url.pathname, query: url.search, verified, body: request.method === "GET" ? null : await request.text() });
        if (url.pathname === "/widget.js") {
            return new Response("/* the widget */", { headers: { "content-type": "application/javascript" } });
        }
        if (url.pathname.endsWith("/message") || url.pathname.endsWith("/proven")) {
            const frames = ["event: delta\\ndata: Hel\\n\\n", "event: delta\\ndata: lo\\n\\n", "event: done\\ndata: \\n\\n"];
            const body = new ReadableStream({ pull: (controller) => (frames.length > 0 ? controller.enqueue(new TextEncoder().encode(frames.shift())) : controller.close()) });
            return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }
        return Response.json({ ok: true });
    });
};
`;

const CHAT_MANIFEST = {
    publisher: "intentic",
    name: "visitor-chat",
    version: "1.0.0",
    engines: { intentic: "^2.54.0" },
    server: "server.js",
    contributes: {
        listener: {
            provider: "webchat",
            strangers: "visitor",
            events: [{ type: "message", label: "Messages" }],
            automation: { label: "Visitor chat", channel: { label: "Visitor thread", placeholder: "every visitor" }, starterPrompt: "A visitor wrote." },
        },
        publicRoutes: [
            { path: "widget.js", methods: ["GET"], dailyMax: "none" },
            { path: "*/config", methods: ["GET"], automation: true, dailyMax: "none" },
            { path: "*/message", methods: ["POST"], automation: true, origins: "listed" },
            { path: "*/proven", methods: ["POST"], automation: true, origins: "listed", proofOfWork: true },
            { path: "*/messages", methods: ["GET"], automation: true, origins: "listed", dailyMax: "none" },
        ],
    },
};

const chat: AutomationRecord = { ...intake, id: "chat", trigger: { kind: "listener", provider: "webchat", allowedOrigins: [SITE] } };

const chatHarness = async (installed: boolean) => {
    const root = mkdtempSync(join(tmpdir(), "moved-chat-"));
    const history = `${root}-history`;
    if (installed) {
        const dir = join(workspaceExtensionsRoot(root), "visitor-chat");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "intentic-extension.json"), JSON.stringify(CHAT_MANIFEST));
        await writeFile(join(dir, "server.js"), CHAT_SERVER);
        await approveExtension(history, "intentic.visitor-chat", ExtensionManifestSchema.parse(CHAT_MANIFEST));
    }
    const quiet = unstubbed<Services["logger"]>("logger", { info: () => undefined, warn: () => undefined, error: console.error });
    const backend = createExtensionBackend(() => svc, 0, quiet);
    started.push(backend);
    const svc = services({
        workspace: workspacePaths(root),
        config: { ...testConfig, extensionsDir: "", historyRoot: history },
        extensionBackend: backend,
        automations: memoryAutomationsStore([chat]),
    });
    await backend.start();
    return createApp(svc);
};

const chatHeard = async (app: ReturnType<typeof createApp>) => HeardSchema.parse(await (await app.request("http://sandbox.test/x/intentic.visitor-chat/heard")).json());

const sendOld = (app: ReturnType<typeof createApp>, body: object, origin: string = SITE) =>
    app.request("http://sandbox.test/webchat/chat/message", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });

test("a pasted snippet's script, and an old widget's settings and poll, reach the Visitor chat extension's own routes", async () => {
    const app = await chatHarness(true);
    const widget = await app.request("http://sandbox.test/webchat/widget.js");
    expect(widget.status).toBe(200);
    expect(await widget.text()).toBe("/* the widget */");
    expect((await app.request("http://sandbox.test/webchat/chat/config", { headers: { origin: SITE } })).status).toBe(200);
    expect((await app.request("http://sandbox.test/webchat/chat/messages?conversation=c1&after=2", { headers: { origin: SITE } })).status).toBe(200);
    expect((await chatHeard(app)).map((call) => [call.path, call.query, call.verified["route"], call.verified["origin"] ?? null])).toEqual([
        ["/widget.js", "", "widget.js", null],
        ["/chat/config", "", "*/config", SITE],
        ["/chat/messages", "?conversation=c1&after=2", "*/messages", SITE],
    ]);
});

test("an old widget's message streams its answer back through the door, unbuffered and in order", async () => {
    const app = await chatHarness(true);
    expect((await sendOld(app, { conversationId: "c1", content: "hi" }, "https://evil.example")).status).toBe(403);
    const answer = await sendOld(app, { conversationId: "c1", content: "hi" });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toContain("text/event-stream");
    expect(answer.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(await answer.text()).toBe("event: delta\ndata: Hel\n\nevent: delta\ndata: lo\n\nevent: done\ndata: \n\n");
    const calls = await chatHeard(app);
    expect(calls.map((call) => [call.path, call.verified["route"]])).toEqual([["/chat/message", "*/message"]]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ conversationId: "c1", content: "hi" });
});

test("an old widget's first message with its proof reaches the route that checks one, the proof bound to its thread", async () => {
    const app = await chatHarness(true);
    const challenge = PowChallengeSchema.parse(await (await app.request("http://sandbox.test/webchat/chat/challenge?conversation=c1", { headers: { origin: SITE } })).json());
    let nonce = 0;
    while (!createHash("sha256").update(`${challenge.salt}:${nonce}`).digest().subarray(0, 2).every((byte) => byte === 0)) {
        nonce += 1;
    }
    const proof = `${challenge.salt}:${nonce}`;
    // Solved for one thread, sent on another.
    expect((await sendOld(app, { conversationId: "c2", content: "hi", powNonce: proof })).status).toBe(403);
    expect((await sendOld(app, { conversationId: "c1", content: "hi", powNonce: proof })).status).toBe(200);
    const calls = await chatHeard(app);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: "/chat/proven", verified: { route: "*/proven", proofOfWork: { caller: "c1" } } });
    expect(JSON.parse(calls[0]?.body ?? "{}")).not.toHaveProperty("powNonce");
});

test("with the Visitor chat extension not on, the old paths say so where the site's owner looks", async () => {
    const app = await chatHarness(false);
    const widget = await app.request("http://sandbox.test/webchat/widget.js");
    expect(widget.status).toBe(404);
    expect(widget.headers.get("content-type")).toContain("javascript");
    expect(await widget.text()).toContain("console.error(");
    const message = await sendOld(app, { conversationId: "c1", content: "hi" });
    expect(message.status).toBe(404);
    expect(await message.json()).toEqual({ error: "the Visitor chat is now an extension, which this sandbox does not have switched on" });
});
