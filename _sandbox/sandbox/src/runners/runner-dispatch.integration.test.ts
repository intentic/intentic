import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { TurnNote } from "@intentic/sandbox-contract/events/transcript";
import type { RunnerTurn,RunnerSyncLine,RunnerFacts } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { ConversationWorktree } from "../conversations/worktrees/worktrees.js";
import type { Services } from "../composition.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAGES_DIR } from "../workspace/files/stored/stored-pages.js";
import { ARTIFACTS_DIR, sha256Of } from "../workspace/files/stored/stored-artifacts.js";
import { dispatchRemoteTurn } from "./runner-dispatch.js";

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
        pictures?: Readonly<Record<string, string>>;
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
        syncWorkspace: os.syncWorkspace.handler(({ input }) => {
            calls.push(`sync:${input.op}`);
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
            const text = options.pictures?.[input.path];
            if (options.old === true || text === undefined) {
                throw new ORPCError("NOT_FOUND");
            }
            const bytes = Buffer.from(text);
            return sha256Of(bytes) === input.have ? {} : { bytesBase64: bytes.toString("base64") };
        }),
        ping: os.ping.handler(() => ({ ok: true })),
        describe: os.describe.handler(notHere),
        reply: os.reply.handler(notHere),
        steer: os.steer.handler(notHere),
        applyDefinition: os.applyDefinition.handler(notHere),
        present: os.present.handler(notHere),
        runCommand: os.runCommand.handler(notHere),
        cancelCommand: os.cancelCommand.handler(notHere),
    });
    const link: OrpcLink<RunnerClient> = await orpcLink<RunnerClient>(router);
    return { client: link.client, calls: () => [...calls], received: () => [...received], close: () => link.close() };
};

const announced: RunnerAnnounced = { version: "test", image: "dev" };

// The parent's side as production builds it, its hub holding whichever socket the test says the runner dialled.
const parent = (workspaceRoot = "/nowhere") => {
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
    expect(second.calls()).toEqual(["heldTurn", "attachTurn:1", "sync:push"]);
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
    expect(runner.calls()).toEqual(["heldTurn", "attachTurn:2", "sync:push", "sync:pull", "runTurn", "sync:push"]);
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
        // In the checkout: the branch's push brings it, so it is never asked for.
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
        expect(runner.calls().filter((call) => call.startsWith("readArtifact:"))).toEqual([`readArtifact:${shot}`, `readArtifact:${attached}`, `readArtifact:${lost}`]);
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
