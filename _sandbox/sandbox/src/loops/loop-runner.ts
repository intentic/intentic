import { mkdir } from "node:fs/promises";
import {
    type AgentTurn,
    type Loop,
    type LoopDocument,
    type LoopIteration,
    type LoopRecord,
    type LoopState,
    profileOf,
} from "@intentic/sandbox-contract";
import { sumUsage, type UsageFrame } from "../agent/run/turn/turn-usage.js";
import type { ConversationActors } from "../conversations/actor/conversation-actors.js";
import type { Holding, Holdings } from "../conversations/actor/conversation-holdings.js";
import type { Services } from "../composition.js";
import { briefForIteration, loopDirIn } from "./loop-brief.js";
import { treeDigest } from "./loop-progress.js";
import { evaluateStop } from "./loop-stop.js";

// Runs a conversation's turn, checks whether the goal is met, and reruns it if not. Daemon-side so a loop survives a
// closed browser; drives an ordinary AgentTurn so it gets the same fleet card, worktree, and cost ledger a composer's
// turn does. Stops (checked each iteration, in order) on: user stop, spend ceiling, stall limit, or iteration budget.

// A conversation's running loop, held under its own id; a dispose presses the loop's Stop, so no loop drives a
// conversation that is gone.
const LOOPS: Holding<{ readonly abort: AbortController }> = { name: "loops", dropped: (loop) => loop.abort.abort(DISPOSED) };
// The reason a dispose's Stop carries, which also keeps the stopped loop's last word off a card nobody has.
const DISPOSED = "disposed";

export const loopRunning = (conversations: Pick<ConversationActors, "holdings">, conversationId: string): boolean =>
    conversations.holdings(LOOPS).has(conversationId);

// Stops a loop after its current iteration finishes; not a turn abort, so in-flight work is kept (use /agent/stop to
// abandon it too). Returns false when nothing was looping.
export const stopLoop = (conversations: Pick<ConversationActors, "holdings">, conversationId: string): boolean => {
    const live = conversations.holdings(LOOPS).get(conversationId);
    live?.abort.abort();
    return live !== undefined;
};

// Lets go of this loop's entry, and only this loop's: one a dispose already took may have been replaced by another.
const release = (loops: Holdings<{ readonly abort: AbortController }>, conversationId: string, abort: AbortController): void => {
    if (loops.get(conversationId)?.abort === abort) {
        loops.drop(conversationId);
    }
};

// Tree an iteration works in: an isolated loop's own checkout, or the workspace itself. Also what the stall detector
// digests, so the two never disagree on which tree is in play.
const treeOf = (services: Services, loop: Loop): string =>
    loop.isolated ? services.agentWorktrees.conversationDir(loop.conversationId) : services.workspace.root;

interface IterationOutcome {
    readonly report: string;
    readonly usage: UsageFrame | undefined;
    readonly sessionId: string | undefined;
    readonly failure: string | undefined;
}

// Runs through the detached turn-run pump a composer's turn uses, so /agent/attach can watch it, reduced to the four values
// the loop needs; `archived` when the conversation was filed away between iterations, which only a person reopens.
const runIteration = async (services: Services, loop: Loop, turn: AgentTurn & { conversationId: string }): Promise<IterationOutcome | "archived"> => {
    const report: string[] = [];
    let usage: UsageFrame | undefined;
    let sessionId: string | undefined;
    let failure: string | undefined;
    const run = services.turns.run({ ...turn, byPerson: false });
    if (run === "archived") {
        return run;
    }
    if (run === "busy") {
        // Another turn is already live (a hand-sent message, or the previous iteration's pump not yet unwound); treated
        // as this iteration's failure rather than raced.
        services.logger.warn({ conversationId: loop.conversationId }, "loop iteration: a turn is already running");
        return { report: "", usage: undefined, sessionId: undefined, failure: "A turn was already running on this conversation." };
    }
    for await (const event of run.frames()) {
        if (event.kind === "delta") {
            report.push(event.text);
        }
        if (event.kind === "usage") {
            usage = sumUsage(usage, event);
        }
        if (event.kind === "session") {
            sessionId = event.sessionId;
        }
        if (event.kind === "error") {
            failure = event.message;
        }
    }
    return { report: report.join(""), usage, sessionId, failure };
};

// Publishes loop state to every fleet card; called at each iteration boundary and once more at the end, since nothing
// else broadcasts after the last one. `stop` is the loop's own, when it has one.
const publish = (services: Pick<Services, "conversations">, loop: Loop, state: LoopState, iteration: number, stop?: AbortSignal): void => {
    if (stop?.reason === DISPOSED) {
        return;
    }
    services.conversations.send(loop.conversationId, {
        kind: "loop-shown",
        loop: { state, iteration, maxIterations: loop.maxIterations, goal: loop.goal },
    });
};

// How a loop ended, returned directly rather than re-read from the store (this is the one moment everything is already
// in hand). A route may ignore it; a workflow step is built entirely from it.
export interface LoopSettlement {
    readonly state: LoopState;
    readonly detail?: string;
    readonly iterations: number;
    // Last iteration's closing assistant text; the entire output of a `none` loop when no document was asked for.
    readonly report: string;
    // Total cost summed from every iteration's usage; returned directly so a caller need not re-read the manifest.
    readonly costUsd: number;
    // Last valid document read, kept even on an `exhausted` loop rather than left blank.
    readonly document?: LoopDocument;
}

// Drives one loop to completion; never rejects, since a failed loop has its own error state and every caller would just
// convert a rejection back into one.
export const runLoop = async (services: Services, record: LoopRecord): Promise<LoopSettlement> => {
    const { conversationId } = record;
    const loops = services.conversations.holdings(LOOPS);
    if (loops.has(conversationId)) {
        return { state: "error", detail: "This agent is already looping.", iterations: record.iterations.length, report: "", costUsd: 0 };
    }
    const abort = new AbortController();
    loops.hold(conversationId, conversationId, { abort });
    const tree = treeOf(services, record);
    // Creates the loop directory upfront so a `fresh` iteration isn't wasting its first move on mkdir.
    await mkdir(loopDirIn(services.workspace.root, conversationId), { recursive: true }).catch((error: unknown) =>
        services.logger.warn({ err: error, conversationId }, "loop: its directory could not be made ahead of the first iteration"),
    );

    let iteration = record.iterations.length;
    let spentUsd = record.iterations.reduce((total, entry) => total + (entry.costUsd ?? 0), 0);
    let stalls = 0;
    // Session to resume in `continue` mode; staying undefined in `fresh` mode is what makes it fresh.
    let sessionId = record.context === "continue" ? services.conversations.sessionIdOf(conversationId) : undefined;
    // Kept across iterations: an exhausted loop's last iteration is often the one that produced the least.
    let report = "";
    let document: LoopDocument | undefined;
    let ended: { readonly state: LoopState; readonly detail?: string } | undefined;
    try {
        while (ended === undefined) {
            if (abort.signal.aborted) {
                ended = { state: "stopped" };
                break;
            }
            if (iteration >= record.maxIterations) {
                ended = { state: "exhausted", detail: `Ran ${iteration} iterations without meeting the goal.` };
                break;
            }
            if (record.maxSpendUsd !== undefined && spentUsd >= record.maxSpendUsd) {
                ended = { state: "overspent", detail: `Spent $${spentUsd.toFixed(2)} of the $${record.maxSpendUsd.toFixed(2)} ceiling.` };
                break;
            }
            iteration += 1;
            publish(services, record, "running", iteration, abort.signal);
            const before = await treeDigest(tree);
            const turn: AgentTurn & { conversationId: string } = {
                prompt: briefForIteration(record, iteration),
                conversationId,
                // The loop's own pick of runtime, persona and placement, the same for every round.
                ...profileOf(record),
                // Marks that nobody is at a composer for this turn (AgentTurn.unattended): changes model defaults and
                // skips interactive prompt decorations.
                unattended: true,
                runRole: `loop-iteration`,
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...(record.worktreeBase !== undefined ? { worktreeBase: record.worktreeBase } : {}),
                ...(record.autoLand !== undefined ? { autoLand: record.autoLand } : {}),
            };
            const outcome = await runIteration(services, record, turn);
            if (outcome === "archived") {
                ended = { state: "stopped", detail: "The conversation was archived, so the loop stopped." };
                break;
            }
            report = outcome.report;
            if (record.context === "continue") {
                sessionId = outcome.sessionId ?? sessionId;
            }
            const after = await treeDigest(tree);
            const changed = before !== after;
            stalls = changed ? 0 : stalls + 1;
            const cost = outcome.usage?.costUsd;
            spentUsd += cost ?? 0;
            // Runs even after an errored iteration: a turn can fail on its closing frame after already meeting the
            // goal, and skipping the check here would redo finished work.
            const verdict = await evaluateStop(services, record, {
                iteration,
                cwd: tree,
                report: outcome.report,
                signal: abort.signal,
            });
            document = verdict.document ?? document;
            // With no output and no checks, evaluateStop always answers done, unable to tell a refused turn from a real
            // one; `verified` gates that, so an unverified turn's own failure is the real verdict.
            const verified = record.output.kind !== "none" || record.checks.length > 0;
            const refused = !verified && outcome.failure !== undefined;
            const done = verdict.done && !refused;
            const entry: LoopIteration = {
                n: iteration,
                at: Date.now(),
                outcome: done ? "done" : outcome.failure !== undefined ? "error" : "continue",
                changed,
                // Turn failure outranks the check's verdict unless the check says done: a refused turn writes nothing,
                // so the check's "no output file" is a symptom, not the cause.
                ...(done
                    ? verdict.detail !== undefined
                        ? { detail: verdict.detail }
                        : {}
                    : (outcome.failure ?? verdict.detail) !== undefined
                      ? { detail: (outcome.failure ?? verdict.detail) as string }
                      : {}),
                ...(cost !== undefined ? { costUsd: cost } : {}),
                ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
            };
            await services.loops.recordIteration(conversationId, entry);
            if (done) {
                ended = { state: "done", ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}) };
                break;
            }
            if (refused) {
                ended = { state: "error", detail: outcome.failure };
                break;
            }
            // Checked after recording the iteration, so the history shows the unchanged runs that earned this verdict.
            if (stalls >= record.stallLimit) {
                // Says so when the stall was every turn being refused, not a wedged agent; otherwise "N iterations
                // changed nothing" would hide that the provider never ran.
                ended = {
                    state: "stalled",
                    detail:
                        outcome.failure === undefined
                            ? `${stalls} iterations in a row changed nothing in the tree.`
                            : `${stalls} iterations in a row changed nothing, the last one failed: ${outcome.failure}`,
                };
            }
        }
    } catch (error) {
        // Only the loop's own machinery lands here (a failed digest, a store write), never an iteration's own failure.
        ended = { state: "error", detail: error instanceof Error ? error.message : "loop failed" };
        services.logger.error({ err: error, conversationId }, "loop failed");
    } finally {
        // Must run on every path: a leaked entry here blocks this conversation from ever looping again.
        release(loops, conversationId, abort);
    }
    const settled = ended ?? { state: "error" as const, detail: "loop ended without a verdict" };
    await services.loops
        .settle(conversationId, settled.state, Date.now(), settled.detail)
        .catch((error: unknown) => services.logger.warn({ err: error, conversationId }, "loop: settle failed"));
    publish(services, record, settled.state, iteration, abort.signal);
    return {
        state: settled.state,
        ...(settled.detail !== undefined ? { detail: settled.detail } : {}),
        iterations: iteration,
        report,
        costUsd: spentUsd,
        ...(document !== undefined ? { document } : {}),
    };
};

// How many boot resumes a run the daemon drives gets before it is abandoned instead: loops and workflows alike.
const RESUME_MAX = 2;

// Resumes every run still marked running that nothing drives (the ledger is the journal: `running` means no settle
// landed), counting each resume; past RESUME_MAX it is abandoned, so a run that reliably kills the daemon ends.
export const resumeCapped = async <R extends { readonly resumed: number }>(
    candidates: readonly R[],
    run: {
        readonly count: (candidate: R) => Promise<R | undefined>;
        readonly abandon: (counted: R) => Promise<void>;
        readonly restart: (counted: R) => void;
    },
): Promise<R[]> => {
    const resumed: R[] = [];
    for (const candidate of candidates) {
        const counted = await run.count(candidate);
        if (counted === undefined) {
            continue;
        }
        if (counted.resumed > RESUME_MAX) {
            await run.abandon(counted);
            continue;
        }
        resumed.push(counted);
        run.restart(counted);
    }
    return resumed;
};

export const resumeLoops = async (services: Services, ownedByWorkflow: ReadonlySet<string> = new Set()): Promise<string[]> => {
    const stranded = (await services.loops.list()).filter(
        (record) =>
            record.state === "running" && !loopRunning(services.conversations, record.conversationId) && !ownedByWorkflow.has(record.conversationId),
    );
    const resumed = await resumeCapped(stranded, {
        count: (record) => services.loops.countResume(record.conversationId),
        abandon: async (record) => {
            await services.loops.settle(record.conversationId, "error", Date.now(), `Abandoned after the daemon died under this loop ${record.resumed} times.`);
            publish(services, record, "error", record.iterations.length);
            services.logger.warn({ conversationId: record.conversationId }, "loop: abandoned after repeated daemon deaths");
        },
        restart: (record) => void runLoop(services, record),
    });
    return resumed.map((record) => record.conversationId);
};
