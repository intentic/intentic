import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { ConversationWorktree } from "../conversations/worktrees/worktrees.js";
import type { Services } from "../composition.js";
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
import type { RunnerSyncLine,RunnerFacts } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
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
const runnerAt = async (turns: RemoteTurns, script: readonly AgentEvent[], options: { dieAfter?: number; redial?: () => void; old?: boolean } = {}) => {
    const calls: string[] = [];
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
        ping: os.ping.handler(() => ({ ok: true })),
        describe: os.describe.handler(notHere),
        reply: os.reply.handler(notHere),
        steer: os.steer.handler(notHere),
        applyDefinition: os.applyDefinition.handler(notHere),
        runCommand: os.runCommand.handler(notHere),
        cancelCommand: os.cancelCommand.handler(notHere),
    });
    const link: OrpcLink<RunnerClient> = await orpcLink<RunnerClient>(router);
    return { client: link.client, calls: () => [...calls], close: () => link.close() };
};

const announced: RunnerAnnounced = { version: "test", image: "dev" };

// The parent's side as production builds it, its hub holding whichever socket the test says the runner dialled.
const parent = () => {
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
        workspace: { root: "/nowhere" },
    };
    return { services, dial, leave: () => dial(undefined) };
};

const dispatched = async (services: DispatchServices, signal?: AbortSignal): Promise<AgentEvent[]> => {
    const frames: AgentEvent[] = [];
    for await (const event of dispatchRemoteTurn(
        services,
        { conversationId: "c1", prompt: "do the thing", agent: "claude", harness: "native", placement: { kind: "runner", id: "rog" } },
        "rog",
        worktree,
        signal,
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
