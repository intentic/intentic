import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeHeavyRules } from "@intentic/constants/heavy-rules";
import { type ExtensionEvent, ExtensionEventSchema, ExtensionExecResultSchema } from "@intentic/sandbox-contract/extension-protocol";
import { EXTENSION_TOKEN_HEADER } from "@intentic/sandbox-contract/headers";
import { unstubbed } from "@intentic/testing";
import { waitFor } from "@intentic/testing/bun";
import { Hono } from "hono";
import type { ExtensionGrant } from "../../auth/grants.js";
import { workingNow } from "../../bootstrap/working-now.js";
import { createHoldingsIndex } from "../../conversations/actor/conversation-holdings.js";
import { memorySecretVault } from "../../capabilities/capabilities-slice.testing.js";
import type { Services } from "../../composition.js";
import { testConfig } from "../../env.config.testing.js";
import { createDomainEvents } from "../../seams/domain-events.js";
import { readWorkspaceFile } from "../../workspace/files/workspace-files.js";
import { recordExtensionConversation } from "./extension-conversations.js";
import { extensionHolds } from "./extension-holds.js";
import { createExtensionDoors } from "./own-doors.js";
import { createExtensionOwnRoutes, ownCaller } from "./own.routes.js";

// What an extension's own code hears, holds and runs beyond its routes (own.routes.ts, own-doors.ts), each refused unless
// its manifest declares it: over a baked extensions tree of two, one declaring everything and one declaring nothing.

const MANIFEST = { version: "1.0.0", engines: { intentic: "^2.50.0" }, server: "dist/server.js" };
const GRANTS = new Map<string, ExtensionGrant>([
    ["maintenance-token", { id: "acme.maintenance", permissions: [] }],
    ["plain-token", { id: "acme.plain", permissions: [] }],
]);

const setup = (live: { now: boolean } = { now: false }) => {
    const root = mkdtempSync(join(tmpdir(), "extension-reach-"));
    const extensionsDir = join(root, "extensions");
    const write = (name: string, manifest: object): void => {
        mkdirSync(join(extensionsDir, name), { recursive: true });
        writeFileSync(join(extensionsDir, name, "intentic-extension.json"), JSON.stringify({ publisher: "acme", name, ...MANIFEST, ...manifest }));
    };
    write("maintenance", { permissions: { events: ["run", "activity"], work: true, exec: ["command"] } });
    write("plain", {});
    const events = createDomainEvents(() => undefined);
    const services = unstubbed<Services>("services", {
        config: { ...testConfig, extensionsDir, historyRoot: join(root, "history") },
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        files: unstubbed<Services["files"]>("files", { read: readWorkspaceFile }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [] }),
        extensionSecretVault: memorySecretVault(),
        extensionBackend: unstubbed<Services["extensionBackend"]>("extensionBackend", { verifyExtensionToken: (presented) => GRANTS.get(presented) }),
        logger: unstubbed<Services["logger"]>("logger", { warn: () => {} }),
        events,
        conversations: unstubbed<Services["conversations"]>("conversations", { liveSessionIds: () => (live.now ? ["s-1"] : []) }),
        resources: unstubbed<Services["resources"]>("resources", { admit: async () => ({ verdict: "run", waitedMs: 0 }), changed: () => {} }),
        heavyCommands: unstubbed<Services["heavyCommands"]>("heavyCommands", { read: async () => ({ ...mergeHeavyRules(), queue: false }) }),
    });
    const routes = createExtensionOwnRoutes(services);
    const doors = createExtensionDoors(services, (c) => ownCaller(services, c));
    const app = new Hono().get("/extension/events", routes.events).post("/extension/work/hold", doors.hold).post("/extension/exec", doors.exec);
    return { root, app, events, services };
};

const as = (token: string, init: RequestInit = {}): RequestInit => ({ ...init, headers: { [EXTENSION_TOKEN_HEADER]: token, "content-type": "application/json" } });

// Reads an ndjson answer's frames as they come, until `stop`.
const framesOf = (response: Response) => {
    const frames: ExtensionEvent[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const pump = (async () => {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                return;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            frames.push(...lines.filter((line) => line !== "").map((line) => ExtensionEventSchema.parse(JSON.parse(line))));
        }
    })();
    return { frames, stop: async () => void (await Promise.all([reader.cancel().catch(() => undefined), pump.catch(() => undefined)])) };
};

describe("declared events", () => {
    test("a kind the manifest does not declare is refused, and an unknown one too", async () => {
        const { app } = setup();
        const refused = await app.request("/extension/events?kinds=activity", as("plain-token"));
        expect(refused.status).toBe(403);
        expect(await refused.json()).toEqual({ error: `extension "acme.plain" did not declare the event kind "activity": add it to permissions.events in its manifest` });
        expect((await app.request("/extension/events?kinds=ci", as("maintenance-token"))).status).toBe(400);
    });

    test("a run ends in its own conversation and not in another's, and activity is told at once and as it flips", async () => {
        const live = { now: true };
        const { app, events, services } = setup(live);
        await recordExtensionConversation(services.config.historyRoot, "fix-1", "acme.maintenance");
        await recordExtensionConversation(services.config.historyRoot, "theirs-1", "acme.plain");
        const controller = new AbortController();
        const stream = framesOf(await app.request("/extension/events?kinds=run,activity", as("maintenance-token", { signal: controller.signal })));
        await waitFor(() => expect(stream.frames).toContainEqual({ kind: "activity", live: true }));

        const settled = { run: "r1", actor: undefined, speaker: undefined, closing: "Fixed the test." };
        events.publish("run.settled", { ...settled, conversationId: "theirs-1", failure: undefined });
        events.publish("run.settled", { ...settled, conversationId: "someone-else", failure: undefined });
        events.publish("run.settled", { ...settled, conversationId: "fix-1", failure: "the allowance ran out" });
        live.now = false;
        events.publish("turn.finished", { conversationId: "fix-1", prompt: "", outcome: { ok: true } });
        await waitFor(() => {
            expect(stream.frames).toContainEqual({ kind: "run", conversationId: "fix-1", run: "r1", outcome: "failed", error: "the allowance ran out", closing: "Fixed the test." });
            expect(stream.frames).toContainEqual({ kind: "activity", live: false });
        });
        expect(stream.frames.filter((frame) => frame.kind === "run")).toHaveLength(1);
        controller.abort();
        await stream.stop();
    });

    test("a stream that asks for nothing declared hears none of it", async () => {
        const { app, events, services } = setup({ now: true });
        await recordExtensionConversation(services.config.historyRoot, "fix-1", "acme.maintenance");
        const controller = new AbortController();
        const stream = framesOf(await app.request("/extension/events", as("maintenance-token", { signal: controller.signal })));
        await waitFor(() => expect(stream.frames).toContainEqual({ kind: "heartbeat" }));
        events.publish("run.settled", { run: "r1", actor: undefined, speaker: undefined, closing: "", conversationId: "fix-1", failure: undefined });
        await Bun.sleep(20);
        expect(stream.frames.filter((frame) => frame.kind !== "heartbeat")).toEqual([]);
        controller.abort();
        await stream.stop();
    });
});

describe("holding work", () => {
    // Nothing else in flight: no conversations, no subagents.
    const quiet = {
        agents: unstubbed<Services["agents"]>("agents", { list: () => [] }),
        conversations: unstubbed<Services["conversations"]>("conversations", {
            holdings: createHoldingsIndex(() => undefined).holdings,
        }),
    };

    test("a hold keeps the machine up and a restart waiting while held, and goes when its holder does", async () => {
        const { app } = setup();
        expect((await app.request("/extension/work/hold", as("plain-token", { method: "POST", body: JSON.stringify({ label: "x" }) }))).status).toBe(403);
        const holder = new AbortController();
        const held = framesOf(await app.request("/extension/work/hold", as("maintenance-token", { method: "POST", body: JSON.stringify({ label: "code-health probes" }), signal: holder.signal })));
        await waitFor(() => expect(held.frames).toContainEqual({ kind: "heartbeat" }));
        expect(workingNow(quiet, "idle-stop")).toContainEqual({ kind: "extension", name: "acme.maintenance: code-health probes" });
        expect(workingNow(quiet, "restart")).toContainEqual({ kind: "extension", name: "acme.maintenance: code-health probes" });
        // The holder dies: its connection closes, and nothing it held is left behind.
        holder.abort();
        await held.stop();
        await waitFor(() => expect(extensionHolds()).toEqual([]));
        expect(workingNow(quiet, "idle-stop")).toEqual([]);
    });
});

describe("running a command", () => {
    test("a declared class runs under admission and answers what the command did", async () => {
        const { app } = setup();
        const body = JSON.stringify({ argv: ["sh", "-c", "echo found; echo warned >&2; exit 3"], class: "command", timeoutMs: 30_000, outputBytes: 4096 });
        const answered = await app.request("/extension/exec", as("maintenance-token", { method: "POST", body }));
        expect(answered.status).toBe(200);
        expect(ExtensionExecResultSchema.parse(await answered.json())).toEqual({ waitedMs: 0, exitCode: 3, stdout: "found\n", stderr: "warned\n", truncated: false });
    });

    test("a class the manifest does not declare is refused, and nothing runs", async () => {
        const { app, root } = setup();
        const marker = join(root, "ran");
        const body = JSON.stringify({ argv: ["touch", marker], class: "toolchain", timeoutMs: 30_000, outputBytes: 4096 });
        const refused = await app.request("/extension/exec", as("maintenance-token", { method: "POST", body }));
        expect(refused.status).toBe(403);
        expect(await refused.json()).toEqual({
            error: `extension "acme.maintenance" did not declare the workload class "toolchain": add it to permissions.exec in its manifest`,
        });
        expect(await Bun.file(marker).exists()).toBe(false);
    });

    test("no room within the deadline answers a refusal, and nothing runs", async () => {
        const { app, root, services } = setup();
        const marker = join(root, "ran");
        Object.assign(services, {
            resources: unstubbed<Services["resources"]>("resources", {
                admit: async () => ({ verdict: "refuse", message: "There is no room for background work right now.", waitedMs: 5 }),
            }),
        });
        const body = JSON.stringify({ argv: ["touch", marker], class: "command", timeoutMs: 30_000, outputBytes: 4096 });
        const answered = await app.request("/extension/exec", as("maintenance-token", { method: "POST", body }));
        expect(ExtensionExecResultSchema.parse(await answered.json())).toEqual({
            refused: "There is no room for background work right now.",
            waitedMs: 5,
            stdout: "",
            stderr: "",
            truncated: false,
        });
        expect(await Bun.file(marker).exists()).toBe(false);
    });
});
