import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runnerIncomingRef } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { TurnNote } from "@intentic/sandbox-contract/events/transcript";
import type { RunnerTurn,RunnerSyncLine,RunnerFacts } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { ConversationWorktree } from "../conversations/worktrees/worktrees.js";
import type { Services } from "../composition.js";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { type PageMediaFile, pageMediaScript } from "@intentic/sandbox-contract/text/pages";
import { sweepArtifactsHome } from "./held-turns/runner-artifacts.js";
import { openRecorded, pageMediaKeyPath, verifiedPageMedia } from "../workspace/files/stored/stored-page-media.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAGES_DIR } from "../workspace/files/stored/stored-pages.js";
import { ARTIFACTS_DIR, sha256Of } from "../workspace/files/stored/stored-artifacts.js";
import { dispatchRemoteTurn } from "./runner-dispatch.js";
import { opt } from "../opt.js";

/* The dispatch's OFFLINE answer, the one path that needs no runner to exist: a machine asleep is a normal state. */

const worktree: ConversationWorktree = { cwd: "/nowhere", branch: "agent/c1", repos: [{ repo: "root", base: "abc" }], fence: undefined, elsewhere: [] };

test("an offline runner is a readable error frame and a closed turn, not a hang", async () => {
    const services = { runnerHub: { client: () => undefined } } as unknown as Services;
    const frames: AgentEvent[] = [];
    for await (const event of dispatchRemoteTurn(
        services,
        { conversationId: "c1", prompt: "do the thing", agent: "claude", harness: "native", placement: { kind: "runner", id: "rog" } },
        "rog",
        worktree,
        undefined,
    )) {
        frames.push(event);
    }
    expect(frames.map((frame) => frame.kind)).toEqual(["error", "done"]);
    const error = frames[0];
    const message = error?.kind === "error" ? error.message : "";
    expect(message).toContain("rog");
    expect(message).toMatch(/offline/i);
});

/* THE DROPPED LINK, as 2026-11-04 had it: the runner's socket dies mid-turn, it redials within seconds, and the turn it
   was running carries on there. Both ends are real (the parent's peer hub, the runner's held-turn registry); only the
   socket between them is a double. */

import { runnerContract } from "@intentic/sandbox-contract/contracts/runner.contract";
import { implement, ORPCError } from "@orpc/server";
import pino from "pino";
import { type OrpcLink, orpcLink } from "../peers/orpc-link.testing.js";
import { createPeerHub } from "../peers/peer-hub.js";
import { createRemoteTurns, type RemoteTurns } from "./held-turns/remote-turns.js";
import type { DispatchServices } from "./runner-dispatch.js";
import { RUNNER_PEER, type RunnerAnnounced, type RunnerClient } from "./runner-peer.js";

const delta = (text: string): AgentEvent => ({ kind: "delta", text });
const done: AgentEvent = { kind: "done" };

// A turn on the runner whose frames the test hands in; a Stop that reaches it ends it.
const scriptedTurn = (frames: readonly AgentEvent[]) =>
    async function* (signal?: AbortSignal): AsyncGenerator<AgentEvent> {
        for (const frame of frames) {
            await new Promise((resolve) => setImmediate(resolve));
            if (signal?.aborted === true) {
                return;
            }
            yield frame;
        }
    };

async function* syncOk(): AsyncGenerator<RunnerSyncLine> {
    yield { kind: "done", ok: true };
}

const notHere = (): never => {
    throw new Error("not called by a dispatch");
};

// A runner at the end of a real oRPC socket, its procedures backed by `turns`. `dieAfter` frames into a stream, the socket
// is dropped under it (the runner's turn carries on in `turns`) and `redial` runs. `old` is a build without the held-turn
// procedures, which answers them NOT_FOUND as any unknown procedure is.
const runnerAt = async (
    turns: RemoteTurns,
    script: readonly AgentEvent[],
    options: {
        dieAfter?: number;
        redial?: () => void;
        old?: boolean;
        pages?: Readonly<Record<string, string>>;
        pictures?: Readonly<Record<string, string | Buffer>>;
        // Files in the conversation's checkout there, by checkout-relative path.
        checkout?: Readonly<Record<string, string>>;
        // What its artifacts folder lists as the turn's, with the size it reports.
        artifacts?: readonly { path: string; size: number }[];
        // What a file in the artifacts folder holds by the time its later pieces are read (one that changed under the copy).
        changedAfterFirst?: Readonly<Record<string, Buffer>>;
        // What a push does on the runner's side (delivering a ref, or hanging), before it answers.
        onPush?: () => Promise<void>;
        // Each page's media files, by page path.
        media?: Readonly<Record<string, readonly (Buffer | undefined)[]>>;
    } = {},
) => {
    const calls: string[] = [];
    const received: RunnerTurn[] = [];
    const dying = async function* (frames: AsyncIterable<AgentEvent>): AsyncGenerator<AgentEvent> {
        let seen = 0;
        for await (const frame of frames) {
            if (options.dieAfter !== undefined && seen === options.dieAfter) {
                await link.drop();
                options.redial?.();
                return;
            }
            seen += 1;
            yield frame;
        }
    };
    const os = implement(runnerContract);
    const router = os.router({
        heldTurn: os.heldTurn.handler(({ input }) => {
            calls.push("heldTurn");
            if (options.old === true) {
                throw new ORPCError("NOT_FOUND");
            }
            return turns.held(input.conversationId);
        }),
        attachTurn: os.attachTurn.handler(({ input }) => {
            calls.push(`attachTurn:${input.after}`);
            const followed = turns.follow(input.conversationId, input.after);
            if (followed === undefined) {
                throw new ORPCError("NOT_FOUND");
            }
            return dying(followed);
        }),
        runTurn: os.runTurn.handler(({ input }) => {
            calls.push("runTurn");
            received.push(input);
            return dying(turns.start(input.conversationId, scriptedTurn(script)) ?? (async function* () {})());
        }),
        syncWorkspace: os.syncWorkspace.handler(async ({ input }) => {
            calls.push(`sync:${input.op}`);
            if (input.op === "push") {
                await options.onPush?.();
            }
            return syncOk();
        }),
        ackTurn: os.ackTurn.handler(({ input }) => {
            turns.ack(input.conversationId, input.after);
            return { ok: true };
        }),
        interrupt: os.interrupt.handler(({ input }) => {
            calls.push("interrupt");
            turns.interrupt(input.conversationId);
            return { ok: true };
        }),
        readPage: os.readPage.handler(({ input }) => {
            calls.push(`readPage:${input.path}`);
            const html = options.pages?.[input.path];
            if (options.old === true || html === undefined) {
                throw new ORPCError("NOT_FOUND");
            }
            return { html };
        }),
        readArtifact: os.readArtifact.handler(({ input }) => {
            calls.push(`readArtifact:${input.path}`);
            const text = input.conversationId !== undefined ? options.checkout?.[input.path] : options.pictures?.[input.path];
            if (options.old === true || text === undefined) {
                throw new ORPCError("NOT_FOUND");
            }
            const bytes = Buffer.from(text);
            if (sha256Of(bytes) === input.have) {
                return input.offset === undefined ? {} : { size: bytes.length };
            }
            if (input.offset === undefined) {
                return { bytesBase64: bytes.toString("base64") };
            }
            const now = input.offset > 0 ? (options.changedAfterFirst?.[input.path] ?? bytes) : bytes;
            const piece = now.subarray(input.offset, input.offset + (input.length ?? now.length));
            return { bytesBase64: piece.toString("base64"), size: now.length, ...opt("sha256", input.offset === 0 ? sha256Of(bytes) : undefined) };
        }),
        listArtifacts: os.listArtifacts.handler(() => {
            calls.push("listArtifacts");
            if (options.old === true) {
                throw new ORPCError("NOT_FOUND");
            }
            return { files: (options.artifacts ?? []).map((file) => ({ ...file, mtimeMs: 0 })) };
        }),
        readPageMedia: os.readPageMedia.handler(({ input }) => {
            calls.push(`readPageMedia:${input.index}:${input.offset}`);
            const bytes = options.media?.[input.page]?.[input.index];
            if (options.old === true || bytes === undefined) {
                throw new ORPCError("NOT_FOUND");
            }
            return {
                bytesBase64: bytes.subarray(input.offset, input.offset + input.length).toString("base64"),
                size: bytes.length,
                ...opt("sha256", input.offset === 0 ? sha256Of(bytes) : undefined),
            };
        }),
        ping: os.ping.handler(() => ({ ok: true })),
        describe: os.describe.handler(notHere),
        reply: os.reply.handler(notHere),
        steer: os.steer.handler(notHere),
        applyDefinition: os.applyDefinition.handler(notHere),
        present: os.present.handler(notHere),
        runCommand: os.runCommand.handler(notHere),
        cancelCommand: os.cancelCommand.handler(notHere),
        feed: os.feed.handler(notHere),
        browsers: os.browsers.handler(notHere),
        openBrowser: os.openBrowser.handler(notHere),
        closeBrowser: os.closeBrowser.handler(notHere),
        closeBrowserPage: os.closeBrowserPage.handler(notHere),
        desktop: os.desktop.handler(notHere),
        stopJob: os.stopJob.handler(notHere),
        stopWatching: os.stopWatching.handler(notHere),
        vetPort: os.vetPort.handler(notHere),
        revoke: os.revoke.handler(notHere),
        browserTab: os.browserTab.handler(notHere),
    });
    const link: OrpcLink<RunnerClient> = await orpcLink<RunnerClient>(router);
    return { client: link.client, calls: () => [...calls], received: () => [...received], close: () => link.close() };
};

const announced: RunnerAnnounced = { version: "test", image: "dev" };

// The parent's side as production builds it, its hub holding whichever socket the test says the runner dialled.
const parent = (workspaceRoot = "/nowhere", historyRoot = "/nowhere") => {
    const hub = createPeerHub<RunnerClient, RunnerAnnounced, RunnerFacts, never>(RUNNER_PEER.hub, { warn: () => undefined });
    let hangUp: (() => void) | undefined;
    const dial = (client: RunnerClient | undefined): void => {
        hangUp?.();
        hangUp = client === undefined ? undefined : hub.attach("rog", { client, close: () => undefined, announced });
    };
    const services: DispatchServices = {
        runnerHub: hub,
        logger: pino({ level: "silent" }),
        // Git on a path that is not a repository fails, which the dispatch reads as nothing to move.
        agentWorktrees: { mainDir: () => "/nowhere", worktreeDir: () => "/nowhere" },
        workspace: { root: workspaceRoot },
        config: { historyRoot },
    };
    return { services, dial, leave: () => dial(undefined) };
};

const dispatched = async (services: DispatchServices, signal?: AbortSignal, childNote?: () => Promise<TurnNote | undefined>): Promise<AgentEvent[]> => {
    const frames: AgentEvent[] = [];
    for await (const event of dispatchRemoteTurn(
        services,
        { conversationId: "c1", prompt: "do the thing", agent: "claude", harness: "native", placement: { kind: "runner", id: "rog" } },
        "rog",
        worktree,
        signal,
        childNote,
    )) {
        frames.push(event);
    }
    return frames;
};

const work = (frames: readonly AgentEvent[]): string[] => frames.flatMap((frame) => (frame.kind === "delta" ? [frame.text] : []));

const waitForCall = async (calls: () => readonly string[], call: string): Promise<void> => {
    for (let tick = 0; tick < 10_000 && !calls().includes(call); tick += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    expect(calls()).toContain(call);
};

test("a link that drops mid-turn is read through: every frame once, the gap said, the branch pushed on the new socket", async () => {
    const turns = createRemoteTurns();
    const { services, dial, leave } = parent();
    const script = [delta("a"), delta("b"), delta("c"), done];
    const second = await runnerAt(turns, script);
    const first = await runnerAt(turns, script, { dieAfter: 1, redial: () => dial(second.client) });
    dial(first.client);
    const frames = await dispatched(services);
    leave();
    expect(work(frames)).toEqual(["a", "b", "c"]);
    expect(frames.filter((frame) => frame.kind === "done")).toHaveLength(1);
    expect(frames.some((frame) => frame.kind === "agent_status" && frame.text !== null)).toBe(true);
    expect(frames.some((frame) => frame.kind === "agent_notice" && frame.text.includes("was down for"))).toBe(true);
    expect(first.calls()).toEqual(["heldTurn", "sync:pull", "runTurn"]);
    // Pushed as `done` arrived, and again by the backstop.
    expect(second.calls()).toEqual(["heldTurn", "attachTurn:1", "sync:push", "listArtifacts", "sync:push"]);
});

// A spawned child placed on a runner: the runner holds no record of it, so the note it opens with is written here and
// travels with the turn (runner-child-note.ts, runner-service.ts).
test("a child's opening note travels with its turn, and a turn without one sends none", async () => {
    const { services, dial, leave } = parent();
    const note = { title: "You are a subagent", text: "## You are a subagent\n\nYou are `sub-kid`." };
    const runner = await runnerAt(createRemoteTurns(), [done]);
    dial(runner.client);
    await dispatched(services, undefined, async () => note);
    await dispatched(services);
    leave();
    expect(runner.received().map((turn) => turn.childNote)).toEqual([note, undefined]);
});

test("a runner that restarted while the link was down says the turn was lost, and its branch still comes back", async () => {
    const { services, dial, leave } = parent();
    const second = await runnerAt(createRemoteTurns(), []);
    const first = await runnerAt(createRemoteTurns(), [delta("a"), delta("b"), done], { dieAfter: 1, redial: () => dial(second.client) });
    dial(first.client);
    const frames = await dispatched(services);
    leave();
    expect(work(frames)).toEqual(["a"]);
    const error = frames.find((frame) => frame.kind === "error");
    expect(error?.kind === "error" ? error.message : "").toMatch(/no longer holds this turn/);
    expect(frames.at(-1)).toEqual(done);
    expect(second.calls()).toContain("sync:push");
});

// 2026-11-24: Docker Desktop died on omen with ten turns on its runner while omen's own agent kept answering; each turn
// waited, read as running, until the agents that spawned them stopped them an hour and more later.
describe("a runner that drops and stays away", () => {
    const endless = [delta("a"), ...Array.from({ length: 50 }, (_, index) => delta(`more ${index}`))];
    const onMachine = (services: DispatchServices, answering: boolean): DispatchServices => ({
        ...services,
        // SAFETY: the relay reads only the runner's id and host off the enrollment.
        runners: { list: async () => [{ id: "rog", card: "rog", host: "omen-pc" }] as never },
        // SAFETY: the relay reads only `pinged` of a device's state.
        hostHub: { state: (door: string) => ({ pinged: answering && door === "omen-pc" ? { at: Date.now(), answer: { ok: true } } : undefined }) as never },
        runnerDownAfterMs: 30,
    });

    test("while its machine still answers is down there: the turn stops following it and says why", async () => {
        const { services, dial, leave } = parent();
        const first = await runnerAt(createRemoteTurns(), endless, { dieAfter: 1, redial: () => leave() });
        dial(first.client);
        const frames = await dispatched(onMachine(services, true));
        expect(work(frames)).toEqual(["a"]);
        const error = frames.find((frame) => frame.kind === "error");
        expect(error?.kind === "error" ? error.message : "").toMatch(/has not come back for .* while its machine still answers/);
        expect(frames.at(-1)).toEqual(done);
    });

    test("while its machine is quiet too is asleep with it: the turn keeps waiting until Stop", async () => {
        const { services, dial, leave } = parent();
        const stop = new AbortController();
        const first = await runnerAt(createRemoteTurns(), endless, { dieAfter: 1, redial: () => leave() });
        dial(first.client);
        const running = dispatched(onMachine(services, false), stop.signal);
        let finished = false;
        void running.then(() => (finished = true));
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(finished).toBe(false);
        stop.abort();
        const frames = await running;
        expect(frames.some((frame) => frame.kind === "error" && frame.message.includes("while its machine still answers"))).toBe(false);
        expect(frames.at(-1)).toEqual(done);
    });
});

test("a runner too old to pick a turn back up is said to be, rather than the turn quietly stopping", async () => {
    const turns = createRemoteTurns();
    const { services, dial, leave } = parent();
    const second = await runnerAt(turns, [], { old: true });
    const first = await runnerAt(turns, [delta("a"), delta("b"), done], { dieAfter: 1, redial: () => dial(second.client), old: true });
    dial(first.client);
    const frames = await dispatched(services);
    leave();
    const error = frames.find((frame) => frame.kind === "error");
    expect(error?.kind === "error" ? error.message : "").toMatch(/cannot pick a turn back up/);
});

test("Stop while the runner is out of reach ends the turn here and reaches the runner once it dials back in", async () => {
    const turns = createRemoteTurns();
    const { services, dial, leave } = parent();
    const stop = new AbortController();
    const endless = [delta("a"), ...Array.from({ length: 50 }, (_, index) => delta(`more ${index}`))];
    const second = await runnerAt(turns, endless);
    const first = await runnerAt(turns, endless, {
        dieAfter: 1,
        redial: () => {
            leave();
            stop.abort();
        },
    });
    dial(first.client);
    const frames = await dispatched(services, stop.signal);
    expect(frames.at(-1)).toEqual(done);
    expect(turns.held("c1").state).toBe("live");
    dial(second.client);
    await waitForCall(second.calls, "interrupt");
    leave();
    for (let tick = 0; tick < 100 && turns.held("c1").state === "live"; tick += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    expect(turns.held("c1").state).toBe("finished");
});

test("a turn the runner still holds from before is collected ahead of the new one: its work shown once, its branch home first", async () => {
    const turns = createRemoteTurns();
    // The earlier turn: its parent had acknowledged two frames before it lost track of it (a restart).
    void turns.start("c1", scriptedTurn([delta("old a"), delta("old b"), delta("old c"), { kind: "error", message: "interrupted" }, done]));
    for (let tick = 0; tick < 100 && turns.held("c1").state === "live"; tick += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    turns.ack("c1", 2);
    const { services, dial, leave } = parent();
    const runner = await runnerAt(turns, [delta("new"), done]);
    dial(runner.client);
    const frames = await dispatched(services);
    leave();
    expect(work(frames)).toEqual(["old c", "new"]);
    // The earlier turn's failure and end are not this turn's.
    expect(frames.filter((frame) => frame.kind === "error")).toEqual([]);
    expect(frames.filter((frame) => frame.kind === "done")).toHaveLength(1);
    const notice = frames.findIndex((frame) => frame.kind === "agent_notice");
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(notice).toBeLessThan(frames.findIndex((frame) => frame.kind === "delta"));
    expect(runner.calls()).toEqual(["heldTurn", "attachTurn:2", "sync:push", "listArtifacts", "sync:pull", "runTurn", "sync:push", "listArtifacts", "sync:push"]);
});

/* THE MIRROR AT `done`: the editor reads Changes, diffs and the checkout's pictures off the mirror the moment a turn ends,
   and caches a 404 for the session, so the branch comes home before `done` is relayed (2026-11-23). */

test("the turn's branch is pushed before its done is relayed", async () => {
    const { services, dial, leave } = parent();
    const runner = await runnerAt(createRemoteTurns(), [delta("a"), done]);
    dial(runner.client);
    let pushedBeforeDone: boolean | undefined;
    for await (const event of dispatchRemoteTurn(
        services,
        { conversationId: "c1", prompt: "do the thing", agent: "claude", harness: "native", placement: { kind: "runner", id: "rog" } },
        "rog",
        worktree,
        undefined,
    )) {
        if (event.kind === "done") {
            pushedBeforeDone = runner.calls().includes("sync:push");
        }
    }
    leave();
    expect(pushedBeforeDone).toBe(true);
});

/* A PAGE THE RUNNER'S TURN SHOWED is filed in the runner's workspace; the chat reads pages from the parent's, so each page
   frame waits for its file to come home (held-turns/runner-pages.ts). bird-mdu4 on omen, 2026-11-23: every page drew as "could not
   be loaded". */

test("a page shown on the runner is filed here before its frame is relayed, and one it cannot fetch still relays", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-pages-"));
    try {
        const shown = `${PAGES_DIR}c1/0123456789.r0.html`;
        const lost = `${PAGES_DIR}c1/abcdefabcd.r0.html`;
        const pageFrame = (path: string): AgentEvent => ({ kind: "page", page: { id: "0123456789", title: "Mock-ups", path } });
        const { services, dial, leave } = parent(root);
        const runner = await runnerAt(createRemoteTurns(), [pageFrame(shown), pageFrame(lost), done], { pages: { [shown]: "<p>both layouts</p>" } });
        dial(runner.client);
        const frames = await dispatched(services);
        leave();
        expect(frames.filter((frame) => frame.kind === "page")).toHaveLength(2);
        expect(await readFile(join(root, shown), "utf8")).toBe("<p>both layouts</p>");
        await expect(readFile(join(root, lost), "utf8")).rejects.toThrow();
        expect(runner.calls()).toContain(`readPage:${shown}`);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/* A PICTURE THE RUNNER'S TURN TOOK lands in the runner's artifacts folder; the chat reads pictures from the parent's, so
   each card naming one waits for its file to come home (held-turns/runner-pictures.ts). boat-pjdf on omen, 2026-11-23:
   every screenshot at the turn's end drew as "No longer available". */

const shotFrame = (id: string, ...paths: string[]): AgentEvent => ({
    kind: "tool_call_update",
    id,
    status: "completed",
    content: [{ type: "text", text: "took it" }, ...paths.map((path) => ({ type: "image" as const, path }))],
});

const picturesIn = (frames: readonly AgentEvent[]): string[] =>
    frames.flatMap((frame) => (frame.kind === "tool_call_update" ? (frame.content ?? []).flatMap((entry) => (entry.type === "image" ? [entry.path] : [])) : []));

test("a screenshot taken on the runner is filed here before its card is relayed; one already here costs no bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-pictures-"));
    try {
        const shot = `${ARTIFACTS_DIR}browser/page-1.png`;
        const attached = `${ARTIFACTS_DIR}attachments/a/image.png`;
        const lost = `${ARTIFACTS_DIR}browser/lost.png`;
        // In the checkout, which this runner does not hold: asked for there, and the card keeps its path.
        const inRepo = "docs/diagram.png";
        await mkdir(join(root, ARTIFACTS_DIR, "attachments/a"), { recursive: true });
        await writeFile(join(root, attached), "the person's picture");
        const { services, dial, leave } = parent(root);
        const runner = await runnerAt(createRemoteTurns(), [shotFrame("t1", shot, attached), shotFrame("t2", lost, inRepo), done], {
            pictures: { [shot]: "pixels of page 1", [attached]: "the person's picture" },
        });
        dial(runner.client);
        const frames = await dispatched(services);
        leave();
        expect(picturesIn(frames)).toEqual([shot, attached, lost, inRepo]);
        expect(await readFile(join(root, shot), "utf8")).toBe("pixels of page 1");
        await expect(readFile(join(root, lost), "utf8")).rejects.toThrow();
        expect(runner.calls().filter((call) => call.startsWith("readArtifact:"))).toEqual([
            `readArtifact:${shot}`,
            `readArtifact:${attached}`,
            `readArtifact:${lost}`,
            `readArtifact:${inRepo}`,
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a runner's shot whose name another picture here already holds is filed under the next free name, and its card says so", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-pictures-"));
    try {
        const shot = `${ARTIFACTS_DIR}browser/after.png`;
        await mkdir(join(root, ARTIFACTS_DIR, "browser"), { recursive: true });
        await writeFile(join(root, shot), "another conversation's after.png");
        const { services, dial, leave } = parent(root);
        // The same shot shown twice (taken, then Read back) is filed once.
        const runner = await runnerAt(createRemoteTurns(), [shotFrame("t1", shot), shotFrame("t2", shot), done], { pictures: { [shot]: "the runner's after.png" } });
        dial(runner.client);
        const frames = await dispatched(services);
        leave();
        const renamed = `${ARTIFACTS_DIR}browser/after-2.png`;
        expect(picturesIn(frames)).toEqual([renamed, renamed]);
        expect(await readFile(join(root, shot), "utf8")).toBe("another conversation's after.png");
        expect(await readFile(join(root, renamed), "utf8")).toBe("the runner's after.png");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/* A PICTURE THE TURN READ FROM ITS OWN CHECKOUT names a path in the conversation's checkout there; the mirror here has no
   file the checkout never committed, so it is fetched from that checkout and filed under runner/<conversation>/
   (2026-11-23). */

test("a picture the turn Read from its checkout is filed under the runner's folder here and its card renamed; an older runner's stays as it was", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-pictures-"));
    try {
        const inRepo = "docs/diagram.png";
        const { services, dial, leave } = parent(root);
        const runner = await runnerAt(createRemoteTurns(), [shotFrame("t1", inRepo), done], { checkout: { [inRepo]: "the diagram, never committed" } });
        dial(runner.client);
        const frames = await dispatched(services);
        const filed = `${ARTIFACTS_DIR}runner/c1/${inRepo}`;
        expect(picturesIn(frames)).toEqual([filed]);
        expect(await readFile(join(root, filed), "utf8")).toBe("the diagram, never committed");

        const old = await runnerAt(createRemoteTurns(), [shotFrame("t1", inRepo), done], { old: true, checkout: { [inRepo]: "x" } });
        dial(old.client);
        expect(picturesIn(await dispatched(services))).toEqual([inRepo]);
        leave();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/* WHAT ELSE THE TURN LEFT in the runner's artifacts folder (a PDF, a video, a trace) is swept home before its `done` is
   relayed, a file past one socket frame in pieces; only what stays behind for its size is said (2026-11-23). */

test("the files a runner's turn left in its artifacts folder are here before its done, a large one in pieces, an oversized one said", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-sweep-"));
    try {
        const report = `${ARTIFACTS_DIR}evidence/report.pdf`;
        const take = `${ARTIFACTS_DIR}renders/take.mp4`;
        const huge = `${ARTIFACTS_DIR}renders/huge.bin`;
        const big = Buffer.alloc(9 * 1024 * 1024 + 17, 7);
        const { services, dial, leave } = parent(root);
        const runner = await runnerAt(createRemoteTurns(), [delta("made them"), done], {
            pictures: { [report]: "%PDF the report", [take]: big },
            artifacts: [
                { path: report, size: 15 },
                { path: take, size: big.length },
                { path: huge, size: 600 * 1024 * 1024 },
            ],
        });
        dial(runner.client);
        const frames: AgentEvent[] = [];
        let sweptBeforeDone = false;
        for await (const event of dispatchRemoteTurn(
            services,
            { conversationId: "c1", prompt: "do the thing", agent: "claude", harness: "native", placement: { kind: "runner", id: "rog" } },
            "rog",
            worktree,
            undefined,
        )) {
            if (event.kind === "done") {
                sweptBeforeDone = (await readFile(join(root, report), "utf8")) === "%PDF the report";
            }
            frames.push(event);
        }
        leave();
        expect(sweptBeforeDone).toBe(true);
        expect(sha256Of(await readFile(join(root, take)))).toBe(sha256Of(big));
        await expect(readFile(join(root, huge))).rejects.toThrow();
        const notices = frames.filter((frame) => frame.kind === "agent_notice");
        expect(notices).toHaveLength(1);
        expect(notices[0]?.kind === "agent_notice" ? notices[0].text : "").toContain(huge);
        // The take came in two pieces.
        expect(runner.calls().filter((call) => call === `readArtifact:${take}`)).toHaveLength(2);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a runner too old to list its artifacts sweeps nothing and says nothing", async () => {
    const { services, dial, leave } = parent();
    const runner = await runnerAt(createRemoteTurns(), [delta("a"), done], { old: true });
    dial(runner.client);
    const frames = await dispatched(services);
    leave();
    expect(frames.filter((frame) => frame.kind === "agent_notice")).toEqual([]);
    expect(frames.at(-1)).toEqual(done);
});

/* A PAGE'S VIDEO AND AUDIO: its manifest names runner paths under the runner's key, so this sandbox would serve none of
   it. Each file is copied here and the manifest re-signed for the copies before the page is filed (2026-11-23). */

test("a runner page's media is copied here and its manifest re-signed with this sandbox's key, so the page plays here", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-media-"));
    const history = await mkdtemp(join(tmpdir(), "runner-media-history-"));
    try {
        const shown = `${PAGES_DIR}c1/0123456789.r0.html`;
        const take = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(9 * 1024 * 1024, 1)]);
        const runnerFile: PageMediaFile = { path: "/work/renders/take.mp4", type: "video/mp4", size: take.length, mtimeMs: 1 };
        const html = `<video src="intentic-media:0"></video>${pageMediaScript({ files: [runnerFile], signature: "the-runner's" })}`;
        const { services, dial, leave } = parent(root, history);
        const runner = await runnerAt(createRemoteTurns(), [{ kind: "page", page: { id: "0123456789", title: "Takes", path: shown } }, done], {
            pages: { [shown]: html },
            media: { [shown]: [take] },
        });
        dial(runner.client);
        await dispatched(services);
        leave();
        const filed = await readFile(join(root, shown), "utf8");
        const media = await verifiedPageMedia(pageMediaKeyPath(history), shown, filed);
        expect(media).toHaveLength(1);
        const copy = media?.[0];
        if (copy === undefined) {
            throw new Error("the filed page names no media");
        }
        expect(copy.path).toBe(await realpath(join(root, ARTIFACTS_DIR, "runner/c1/media/take.mp4")));
        expect(copy.size).toBe(take.length);
        expect(sha256Of(await readFile(copy.path))).toBe(sha256Of(take));
        // As the media route opens it: unchanged, inside the workspace, the format its name says.
        const opened = await openRecorded(copy, [await realpath(root)]);
        expect("handle" in opened).toBe(true);
        if ("handle" in opened) {
            await opened.handle.close();
        }
        expect(filed).toContain(`<video src="intentic-media:0"></video>`);
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(history, { recursive: true, force: true });
    }
});

// A turn collected ahead of the next message (one this sandbox lost track of) left its files on the runner before the
// live turn's window opens: they are swept home with it, before the live turn's pull (2026-11-23).
test("a collected turn's artifacts are swept home before the live turn runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-sweep-collected-"));
    try {
        const turns = createRemoteTurns();
        void turns.start("c1", scriptedTurn([delta("old a"), delta("old b"), done]));
        for (let tick = 0; tick < 100 && turns.held("c1").state === "live"; tick += 1) {
            await new Promise((resolve) => setImmediate(resolve));
        }
        turns.ack("c1", 1);
        const report = `${ARTIFACTS_DIR}evidence/earlier-report.pdf`;
        const { services, dial, leave } = parent(root);
        const runner = await runnerAt(turns, [delta("new"), done], { pictures: { [report]: "%PDF earlier" }, artifacts: [{ path: report, size: 12 }] });
        dial(runner.client);
        let filedBeforeLive: string | undefined;
        for await (const event of dispatchRemoteTurn(
            services,
            { conversationId: "c1", prompt: "do the thing", agent: "claude", harness: "native", placement: { kind: "runner", id: "rog" } },
            "rog",
            worktree,
            undefined,
        )) {
            if (event.kind === "delta" && event.text === "new") {
                filedBeforeLive = await readFile(join(root, report), "utf8");
            }
        }
        leave();
        expect(filedBeforeLive).toBe("%PDF earlier");
        const calls = runner.calls();
        expect(calls.indexOf("listArtifacts")).toBeLessThan(calls.indexOf("sync:pull"));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/* THE MIRROR'S DELIVERIES: the push at `done` and the backstop's push deliver the same tip, and the second must not reset
   a mirror that moved on since; but a tip older than the mirror is the runner's own rewind, applied like any other. */

const execGit = promisify(execFile);
const gitIn = async (cwd: string, ...args: string[]): Promise<string> =>
    (await execGit("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();

const mirrorRepo = async (base: string) => {
    const main = join(base, "main");
    const checkout = join(base, "c1");
    await mkdir(main);
    await gitIn(main, "init", "-q");
    await writeFile(join(main, "readme.md"), "a\n");
    await gitIn(main, "add", ".");
    await gitIn(main, "commit", "-qm", "a");
    await gitIn(main, "worktree", "add", "-q", "-b", "agent/c1", checkout);
    const commit = async (name: string): Promise<string> => {
        await writeFile(join(checkout, name), `${name}\n`);
        await gitIn(checkout, "add", ".");
        await gitIn(checkout, "commit", "-qm", name);
        return gitIn(checkout, "rev-parse", "HEAD");
    };
    return { main, checkout, commit };
};

test("the backstop's second delivery of the tip done applied leaves a mirror that moved on since as it is", async () => {
    const base = await mkdtemp(join(tmpdir(), "runner-mirror-"));
    try {
        const { main, checkout, commit } = await mirrorRepo(base);
        const delivered = await commit("delivered.md");
        await gitIn(checkout, "reset", "-q", "--hard", "HEAD~1");
        let pushes = 0;
        const { services, dial, leave } = parent();
        const here = { ...services, agentWorktrees: { mainDir: () => main, worktreeDir: () => checkout } };
        const runner = await runnerAt(createRemoteTurns(), [done], {
            onPush: async () => {
                pushes += 1;
                await gitIn(main, "update-ref", runnerIncomingRef("c1"), delivered);
            },
        });
        dial(runner.client);
        const movedOn = { at: "" };
        for await (const event of dispatchRemoteTurn(
            here,
            { conversationId: "c1", prompt: "do the thing", agent: "claude", harness: "native", placement: { kind: "runner", id: "rog" } },
            "rog",
            worktree,
            undefined,
        )) {
            if (event.kind === "done") {
                // Applied at done; then moved on here (a catch-up) with an edit not yet committed.
                expect(await gitIn(checkout, "rev-parse", "HEAD")).toBe(delivered);
                movedOn.at = await commit("later.md");
                await writeFile(join(checkout, "readme.md"), "uncommitted\n");
            }
        }
        leave();
        expect(pushes).toBe(2);
        expect(await gitIn(checkout, "rev-parse", "HEAD")).toBe(movedOn.at);
        expect(await readFile(join(checkout, "readme.md"), "utf8")).toBe("uncommitted\n");
        await expect(gitIn(main, "rev-parse", "--verify", "--quiet", runnerIncomingRef("c1"))).rejects.toThrow();
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

// Review, 2026-11-23: an ancestor of the mirror's tip used to be skipped as already held, swallowing a `git reset --hard
// HEAD~1` the agent made on the runner; the next pull then reset the runner back and the dropped commit was landed.
test("a tip older than the mirror's, the runner's own rewind, moves the mirror back to it", async () => {
    const base = await mkdtemp(join(tmpdir(), "runner-rewind-"));
    try {
        const { main, checkout, commit } = await mirrorRepo(base);
        const kept = await commit("kept.md");
        await commit("dropped.md");
        const { services, dial, leave } = parent();
        const here = { ...services, agentWorktrees: { mainDir: () => main, worktreeDir: () => checkout } };
        const runner = await runnerAt(createRemoteTurns(), [done], { onPush: () => gitIn(main, "update-ref", runnerIncomingRef("c1"), kept).then(() => undefined) });
        dial(runner.client);
        await dispatched(here);
        leave();
        expect(await gitIn(checkout, "rev-parse", "HEAD")).toBe(kept);
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

// Review, 2026-11-23: the push at `done` queues behind the runner's other git work, so `done` waits for it only so long,
// then goes on; the backstop push waits for that first one and delivers after it.
test("a push at done that hangs holds done only as long as its bound, and the backstop still delivers after it", async () => {
    let release: () => void = () => undefined;
    const hung = new Promise<void>((resolve) => (release = resolve));
    let pushes = 0;
    const { services, dial, leave } = parent();
    const runner = await runnerAt(createRemoteTurns(), [delta("a"), done], {
        onPush: async () => {
            pushes += 1;
            if (pushes === 1) {
                await hung;
            }
        },
    });
    dial(runner.client);
    let pushesAtDone = -1;
    for await (const event of dispatchRemoteTurn(
        { ...services, doneDeliveryMs: 50 },
        { conversationId: "c1", prompt: "do the thing", agent: "claude", harness: "native", placement: { kind: "runner", id: "rog" } },
        "rog",
        worktree,
        undefined,
    )) {
        if (event.kind === "done") {
            pushesAtDone = pushes;
            release();
        }
    }
    leave();
    expect(pushesAtDone).toBe(1);
    expect(pushes).toBe(2);
});

// Review, 2026-11-23: a file in pieces was filed however its pieces came, so one growing or rewritten between them was
// filed mixed. The assembled copy is checked against the size every piece reports and the digest the first carries.
test("a file that changes between its pieces is not filed, whether its size moved or only its bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-sweep-moved-"));
    try {
        const grew = `${ARTIFACTS_DIR}renders/grew.mp4`;
        const rewritten = `${ARTIFACTS_DIR}renders/rewritten.mp4`;
        const first = Buffer.alloc(9 * 1024 * 1024, 1);
        const { services, dial, leave } = parent(root);
        const runner = await runnerAt(createRemoteTurns(), [done], {
            pictures: { [grew]: first, [rewritten]: first },
            changedAfterFirst: { [grew]: Buffer.alloc(first.length + 5, 2), [rewritten]: Buffer.alloc(first.length, 3) },
            artifacts: [
                { path: grew, size: first.length },
                { path: rewritten, size: first.length },
            ],
        });
        dial(runner.client);
        await dispatched(services);
        leave();
        await expect(readFile(join(root, grew))).rejects.toThrow();
        await expect(readFile(join(root, rewritten))).rejects.toThrow();
        // No part left behind either.
        expect(await readdir(join(root, ARTIFACTS_DIR, "renders"))).toEqual([]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

// Review, 2026-11-23: the per-turn cap summed the sizes the runner listed, so a runner listing 0 bytes was never capped.
test("a sweep's per-turn cap counts the bytes that came, not the sizes the runner listed", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-sweep-cap-"));
    try {
        const one = `${ARTIFACTS_DIR}a.bin`;
        const two = `${ARTIFACTS_DIR}b.bin`;
        const { services, dial, leave } = parent(root);
        const runner = await runnerAt(createRemoteTurns(), [], {
            pictures: { [one]: Buffer.alloc(600, 1), [two]: Buffer.alloc(600, 2) },
            artifacts: [
                { path: one, size: 0 },
                { path: two, size: 0 },
            ],
        });
        dial(runner.client);
        const home = { hub: services.runnerHub, logger: services.logger, runnerId: "rog", workspaceRoot: root };
        const notices = await sweepArtifactsHome(home, 1000, 1000);
        leave();
        expect((await readFile(join(root, one))).length).toBe(600);
        await expect(readFile(join(root, two))).rejects.toThrow();
        expect(notices).toHaveLength(1);
        expect(notices[0]?.kind === "agent_notice" ? notices[0].text : "").toContain(two);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

// Review, 2026-11-23: a take that could not be copied kept the runner's entry, signed with this sandbox's key. It now
// leaves the manifest: the copies are renumbered, and its reference names nothing, so the page shows it missing.
test("a page's take that could not be brought leaves the manifest, the rest renumbered, nothing of the runner's signed", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-media-lost-"));
    const history = await mkdtemp(join(tmpdir(), "runner-media-lost-history-"));
    try {
        const shown = `${PAGES_DIR}c1/0123456789.r0.html`;
        const take = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(64, 1)]);
        const lost: PageMediaFile = { path: "/work/renders/lost.mp4", type: "video/mp4", size: 10, mtimeMs: 1 };
        const kept: PageMediaFile = { path: "/work/renders/kept.mp4", type: "video/mp4", size: take.length, mtimeMs: 1 };
        const html = `<video src="intentic-media:0"></video><video src="intentic-media:1"></video>${pageMediaScript({ files: [lost, kept], signature: "the-runner's" })}`;
        const { services, dial, leave } = parent(root, history);
        const runner = await runnerAt(createRemoteTurns(), [{ kind: "page", page: { id: "0123456789", title: "Takes", path: shown } }, done], {
            pages: { [shown]: html },
            media: { [shown]: [undefined, take] },
        });
        dial(runner.client);
        await dispatched(services);
        leave();
        const filed = await readFile(join(root, shown), "utf8");
        const media = await verifiedPageMedia(pageMediaKeyPath(history), shown, filed);
        expect(media?.map((file) => file.path)).toEqual([await realpath(join(root, ARTIFACTS_DIR, "runner/c1/media/kept.mp4"))]);
        expect(filed).toContain(`<video src="intentic-media-unavailable:0"></video><video src="intentic-media:0"></video>`);
        expect(filed).not.toContain(lost.path);
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(history, { recursive: true, force: true });
    }
});
