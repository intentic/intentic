import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionManifest, ExtensionManifestSchema, type ExtensionTurnPower } from "@intentic/extension-manifest";
import { type ExtensionJobFrame, ExtensionJobFrameSchema, type ToolCallGrants } from "@intentic/sandbox-contract/extension-protocol";
import { CapabilitySchema } from "@intentic/sandbox-contract/schemas/capabilities";
import { Hono } from "hono";
import { z } from "zod";
import { backgroundJobOf, jobStatusPath, stopBackgroundJob } from "../../agent/tools/jobs/background-jobs.js";
import { startDaemonJob } from "../../agent/tools/jobs/daemon/daemon-jobs.js";
import { createJobLanes } from "../../agent/tools/jobs/daemon/job-lanes.js";
import { jobReport } from "../../agent/tools/jobs/job-report.js";
import type { InProcessServer, MountTarget, RpcMessage } from "../../agent/tools/turn-mounts.js";
import type { MountCall } from "../../agent/tools/turn-mounts.routes.js";
import { untilFileAppears } from "../../agent/tools/file-appears.js";
import type { AppEnv } from "../../app-env.js";
import type { InstalledExtension } from "../../capabilities/extension-inventory/installed-extensions.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { createTurnTickets, type TurnTicket } from "./tool-grants.js";
import { createTurnDoors } from "./tool-turn-doors.js";

// (2026-11-26) The doors an extension tool's call opens onto its turn: each answers only the ticket of that extension's
// own call (or a job it started), only for a power its manifest declares, only within what the turn holds, and masks
// whatever comes back.

const actors = memoryFleet().conversations;
const ROOT = mkdtempSync(join(tmpdir(), "turn-doors-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const manifestOf = (name: string, turn: readonly ExtensionTurnPower[]): ExtensionManifest =>
    ExtensionManifestSchema.parse({ publisher: "test", name, version: "1.0.0", engines: { intentic: "^2.55.0" }, server: "server.js", permissions: { turn } });

// Who calls is named by a header standing in for its token.
const EXTENSIONS = new Map<string, InstalledExtension>([
    ["kit", { id: "test.kit", dir: "/x/kit", manifest: manifestOf("kit", ["browser", "owner-browser", "jobs"]), source: "builtin", enabled: true }],
    ["plain", { id: "test.plain", dir: "/x/plain", manifest: manifestOf("plain", []), source: "builtin", enabled: true }],
]);

const GRANTS: ToolCallGrants = { accounts: [{ id: "chatgpt", kind: "browser", sites: ["chatgpt.com"] }], browsers: ["brave"], cards: [] };

// The turn's own signed-in browser router, its page on chatgpt.com, answering every page tool with a stored secret in it.
const router: InProcessServer = {
    handle: async (message: RpcMessage) => ({
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: { content: [{ type: "text", text: message.params?.["name"] === "browser_evaluate" ? '### Result\n"https://chatgpt.com/"' : "token s3cret on the page" }] },
    }),
    close: () => undefined,
};

// The owner's browser answering a call, as its peer door does.
type OwnerAnswer = (message: RpcMessage) => Promise<RpcMessage>;
const READS: OwnerAnswer = async (message) => ({ jsonrpc: "2.0", id: message.id ?? null, result: { content: [{ type: "text", text: "read s3cret" }] } });

const setup = (owner: OwnerAnswer = READS) => {
    const tickets = createTurnTickets();
    const ownerCalls: { readonly id: string; readonly message: RpcMessage; readonly call: MountCall }[] = [];
    const mounted = new Map<string, MountTarget>([["browser", { kind: "browser", router }]]);
    const doors = createTurnDoors({
        tickets,
        caller: async (c) => EXTENSIONS.get(c.req.header("x-test-extension") ?? "") ?? c.json({ error: "not an extension's token" }, 403),
        capabilities: {
            get: async (id) => (id === "brave" ? CapabilitySchema.parse({ id: "brave", kind: "webext", config: { platform: "brave" } }) : undefined),
        },
        mask: async (value) => JSON.parse(JSON.stringify(value).replaceAll("s3cret", "{{secret:token}}")),
        ownerBrowser: async (target, message, call) => {
            ownerCalls.push({ id: target.id, message, call });
            return await owner(message);
        },
        seedOf: (conversationId) => ({ conversationId, profile: {}, conversations: actors, tmp: ROOT }),
        startJob: startDaemonJob,
        jobLanes: createJobLanes,
    });
    const app = new Hono<AppEnv>()
        .post("/extension/turn/browser", doors["POST /extension/turn/browser"])
        .post("/extension/turn/owner-browser", doors["POST /extension/turn/owner-browser"])
        .post("/extension/jobs", doors["POST /extension/jobs"])
        .post("/extension/jobs/:id", doors["POST /extension/jobs/{id}"]);
    const post = (path: string, extension: string, body: object) =>
        app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-test-extension": extension }, body: JSON.stringify(body) });
    const mint = (standing: Partial<TurnTicket> = {}) =>
        tickets.mint({ extension: "test.kit", conversationId: "conv-doors", grants: GRANTS, turn: { granted: [], mounted: () => mounted }, ...standing }).ticket;
    return { post, mint, mounted, ownerCalls, tickets };
};

const RefusalSchema = z.object({ error: z.string() });
const refusalOf = async (answer: Response): Promise<string> => RefusalSchema.parse(await answer.json()).error;

describe("the turn's own browser", () => {
    test("drives an account the turn holds, its answer masked", async () => {
        const { post, mint } = setup();
        const answer = await post("/extension/turn/browser", "kit", { turn: mint(), account: "chatgpt", tool: "browser_snapshot" });
        expect(await answer.json()).toEqual({ result: { content: [{ type: "text", text: "token {{secret:token}} on the page" }] } });
    });

    test.each([
        ["a ticket minted for another extension", "kit", { extension: "test.other" }, { account: "chatgpt" }, 403, "is running under that ticket"],
        ["an extension that did not declare it", "plain", { extension: "test.plain" }, { account: "chatgpt" }, 403, 'did not declare "browser" in permissions.turn'],
        ["an account the turn does not hold", "kit", {}, { account: "x" }, 403, 'holds no account "x"; it holds "chatgpt"'],
        ["a turn that has ended", "kit", { turn: { granted: [], mounted: () => new Map() } }, { account: "chatgpt" }, 409, "holds no signed-in browser now"],
    ] as const)("refuses %s", async (_name, extension, standing, asked, status, words) => {
        const { post, mint } = setup();
        const answer = await post("/extension/turn/browser", extension, { turn: mint(standing), tool: "browser_snapshot", ...asked });
        expect(answer.status).toBe(status);
        expect(await refusalOf(answer)).toContain(words);
    });
});

describe("the owner's browser", () => {
    test("is reached through its peer door, in the call's conversation, only when the turn holds it", async () => {
        const { post, mint, ownerCalls } = setup();
        const answer = await post("/extension/turn/owner-browser", "kit", { turn: mint(), browser: "brave", tool: "read", arguments: { url: "https://chatgpt.com/" } });
        expect(await answer.json()).toEqual({ result: { content: [{ type: "text", text: "read {{secret:token}}" }] } });
        expect(ownerCalls.map((each) => ({ id: each.id, params: each.message.params, conversationId: each.call.conversationId }))).toEqual([
            { id: "brave", params: { name: "read", arguments: { url: "https://chatgpt.com/" } }, conversationId: "conv-doors" },
        ]);

        const notHeld = await post("/extension/turn/owner-browser", "kit", { turn: mint({ grants: { ...GRANTS, browsers: [] } }), browser: "brave", tool: "read" });
        expect(notHeld.status).toBe(403);
        expect(await refusalOf(notHeld)).toContain(`holds no browser of the owner's called "brave"`);
        const removed = await post("/extension/turn/owner-browser", "kit", { turn: mint({ grants: { ...GRANTS, browsers: ["chrome"] } }), browser: "chrome", tool: "read" });
        expect(await refusalOf(removed)).toContain("no longer one of the owner's connected browsers");
        expect(ownerCalls).toHaveLength(1);
    });

    // (2026-11-26) Node's fetch gives up on headers that take five minutes, and a ChatGPT image there takes nine.
    test("answers its status at once and the browser's answer when it comes, a failure past that as the result's error", async () => {
        const browser = Promise.withResolvers<RpcMessage>();
        const slow = setup(async () => await browser.promise);
        const answer = await slow.post("/extension/turn/owner-browser", "kit", { turn: slow.mint(), browser: "brave", tool: "chatgpt_image", arguments: { prompt: "A fox." } });
        expect(answer.status).toBe(200);
        expect(slow.ownerCalls).toHaveLength(1);
        browser.resolve({ jsonrpc: "2.0", id: null, result: { content: [{ type: "text", text: "Made 1 image." }] } });
        expect(await answer.json()).toEqual({ result: { content: [{ type: "text", text: "Made 1 image." }] } });

        const failing = setup(async () => await Promise.reject(new Error("the browser went away")));
        const failed = await failing.post("/extension/turn/owner-browser", "kit", { turn: failing.mint(), browser: "brave", tool: "read" });
        expect(failed.status).toBe(200);
        expect(await failed.json()).toEqual({ result: { content: [{ type: "text", text: "The call failed: the browser went away" }], isError: true } });
    });
});

// The frames a job's stream says, read as they come until `until` is true of what was read; the stream is left open, as
// a backend whose job runs on holds it, unless `letGo`, which closes it as a backend that stopped does.
const framesUntil = async (answer: Response, until: (frames: readonly ExtensionJobFrame[]) => boolean, letGo = false): Promise<ExtensionJobFrame[]> => {
    const frames: ExtensionJobFrame[] = [];
    const reader = answer.body?.getReader();
    if (reader === undefined) {
        return frames;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    while (!until(frames)) {
        const chunk = await reader.read();
        if (chunk.done) {
            break;
        }
        const parts = (buffer + decoder.decode(chunk.value, { stream: true })).split("\n");
        buffer = parts.pop() ?? "";
        frames.push(...parts.filter((line) => line.trim() !== "").map((line) => ExtensionJobFrameSchema.parse(JSON.parse(line))));
    }
    if (letGo) {
        await reader.cancel();
    } else {
        reader.releaseLock();
    }
    return frames;
};

const JOB = { command: "chatgpt_image cat", description: "ChatGPT image: a cat", started: "Making a cat." };

describe("a background job", () => {
    test("is filed in the call's conversation, begins at once, and ends with what the backend reports", async () => {
        const { post, mint, tickets } = setup();
        const answer = await post("/extension/jobs", "kit", { turn: mint(), ...JOB });
        const frames = await framesUntil(answer, (read) => read.some((frame) => frame.kind === "begin"));
        const filed = frames[0];
        if (filed?.kind !== "filed") {
            throw new Error(`the job was not filed: ${JSON.stringify(frames)}`);
        }
        expect(frames).toEqual([{ kind: "filed", id: filed.id, job: filed.job, ahead: 0 }, { kind: "begin" }]);
        // The job's own ticket stands on the same grants, in the same conversation.
        expect(tickets.read(filed.job)).toMatchObject({ extension: "test.kit", conversationId: "conv-doors", grants: GRANTS, job: filed.id });
        const job = backgroundJobOf(actors, "conv-doors", filed.id);
        if (job === undefined) {
            throw new Error("the conversation holds no such job");
        }
        expect((await post(`/extension/jobs/${filed.id}`, "kit", { job: filed.job, say: "sent to ChatGPT" })).status).toBe(200);
        expect((await post(`/extension/jobs/${filed.id}`, "kit", { job: filed.job, end: { ok: true, output: "Saved cat.png (s3cret)" } })).status).toBe(200);
        await untilFileAppears(jobStatusPath(job), 2_000);
        expect(await jobReport(actors, job)).toMatchObject({ running: false, exitCode: 0, outputTail: "Saved cat.png ({{secret:token}})\n" });
        // Once the job ended its ticket reaches nothing.
        expect((await post(`/extension/jobs/${filed.id}`, "kit", { job: filed.job, say: "late" })).status).toBe(403);
    });

    test("ends failed when the backend lets go of it first", async () => {
        const { post, mint } = setup();
        const answer = await post("/extension/jobs", "kit", { turn: mint(), ...JOB });
        const [filed] = await framesUntil(answer, (read) => read.length > 0, true);
        const job = filed?.kind === "filed" ? backgroundJobOf(actors, "conv-doors", filed.id) : undefined;
        if (job === undefined) {
            throw new Error("the job was not filed");
        }
        await untilFileAppears(jobStatusPath(job), 2_000);
        expect(await jobReport(actors, job)).toMatchObject({ exitCode: 1, outputTail: expect.stringContaining("let go of this job before it ended") });
    });

    test("stopped by the agent, its stream says so and its end is the stop's", async () => {
        const { post, mint } = setup();
        const answer = await post("/extension/jobs", "kit", { turn: mint(), ...JOB });
        const [filed] = await framesUntil(answer, (read) => read.length > 0);
        const job = filed?.kind === "filed" ? backgroundJobOf(actors, "conv-doors", filed.id) : undefined;
        if (job === undefined || filed?.kind !== "filed") {
            throw new Error("the job was not filed");
        }
        expect(await stopBackgroundJob(actors, job, "agent")).toBe(true);
        expect(await framesUntil(answer, (read) => read.some((frame) => frame.kind === "stopped"))).toContainEqual({ kind: "stopped" });
        // The work's end after the stop is read by nobody: the stop already wrote it.
        await post(`/extension/jobs/${filed.id}`, "kit", { job: filed.job, end: { ok: true, output: "late words" } });
        expect(await jobReport(actors, job)).toMatchObject({ exitCode: 143 });
    });

    test("waits its turn in its lane: up to the lane's most at once once one went well, never two of one key", async () => {
        const { post, mint } = setup();
        const start = async (key: string) => {
            const answer = await post("/extension/jobs", "kit", { turn: mint(), ...JOB, lane: { name: "brave", key, most: 2 } });
            return { answer, frames: await framesUntil(answer, (read) => read.length > 0) };
        };
        const begins = async (answer: Response) => await framesUntil(answer, (read) => read.some((frame) => frame.kind === "begin"));
        // A lane runs one at a time until a run of it has gone well (job-lanes.ts), so one goes first.
        const warm = await start("chat-0");
        const warmed = warm.frames[0];
        if (warmed?.kind !== "filed") {
            throw new Error("the warming job was not filed");
        }
        await post(`/extension/jobs/${warmed.id}`, "kit", { job: warmed.job, end: { ok: true, output: "done" } });
        const first = await start("chat-1");
        const filed = first.frames[0];
        if (filed?.kind !== "filed") {
            throw new Error("the first job was not filed");
        }
        const firstBegun = first.frames.some((frame) => frame.kind === "begin") || (await begins(first.answer)).length > 0;
        expect(firstBegun).toBe(true);
        // A second in the same chat waits behind the first; a third in another chat has room beside it.
        const second = await start("chat-1");
        expect(second.frames[0]).toMatchObject({ kind: "filed", ahead: 1 });
        const third = await start("chat-2");
        expect(third.frames.some((frame) => frame.kind === "begin") || (await begins(third.answer)).some((frame) => frame.kind === "begin")).toBe(true);
        // What the second's stream holds so far: a begin would already be there, since lanes admit as soon as they can.
        const reader = second.answer.body?.getReader();
        const pending = await Promise.race([reader?.read().then(() => "a frame"), new Promise((resolve) => setTimeout(() => resolve("nothing yet"), 50))]);
        expect(pending).toBe("nothing yet");
        reader?.releaseLock();
        await post(`/extension/jobs/${filed.id}`, "kit", { job: filed.job, end: { ok: true, output: "done" } });
        expect((await begins(second.answer)).map((frame) => frame.kind)).toContain("begin");
    });

    test("is refused for a call with no conversation, or another extension's job", async () => {
        const { post, mint } = setup();
        const none = await post("/extension/jobs", "kit", { turn: mint({ conversationId: undefined }), ...JOB });
        expect(none.status).toBe(409);
        const answer = await post("/extension/jobs", "kit", { turn: mint(), ...JOB });
        const [filed] = await framesUntil(answer, (read) => read.length > 0);
        if (filed?.kind !== "filed") {
            throw new Error("the job was not filed");
        }
        const foreign = await post(`/extension/jobs/${filed.id}`, "kit", { job: mint(), end: { ok: true, output: "x" } });
        expect(foreign.status).toBe(404);
        await post(`/extension/jobs/${filed.id}`, "kit", { job: filed.job, end: { ok: true, output: "done" } });
    });
});
