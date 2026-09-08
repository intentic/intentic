import { mkdir } from "node:fs/promises";
import type { AgentEvent, AgentTurn, Loop, LoopDocument, LoopIteration, LoopRecord, LoopState } from "@intentic/sandbox-contract";
import { startTurnRun } from "../agent/run/turn/turn-runs.js";
import type { TurnInput } from "../agent/run/turn/turn-actor.js";
import { sumUsage, type UsageFrame } from "../agent/run/turn/turn-usage.js";
import type { Services } from "../composition.js";
import { openingRows, openTurnTranscript, recordTurnTranscript } from "../sessions/turn-transcript.js";
import { briefForIteration, loopDirIn } from "./loop-brief.js";
import { treeDigest } from "./loop-progress.js";
import { evaluateStop } from "./loop-stop.js";
import { loopProjection } from "./loop-state.js";

// Runs a conversation's turn, checks whether the goal is met, and reruns it if not. Daemon-side so a loop survives a
// closed browser; drives an ordinary AgentTurn so it gets the same fleet card, worktree, and cost ledger a composer's
// turn does. Stops (checked each iteration, in order) on: user stop, spend ceiling, stall limit, or iteration budget.

// Running loops, keyed by conversation; a singleton so routes, boot resume, and tests share one set.
const running = new Map<string, { readonly abort: AbortController }>();

export const loopRunning = (conversationId: string): boolean => running.has(conversationId);

// Stops a loop after its current iteration finishes; not a turn abort, so in-flight work is kept (use /agent/stop to
// abandon it too). Returns false when nothing was looping.
export const stopLoop = (conversationId: string): boolean => {
    const live = running.get(conversationId);
    live?.abort.abort();
    return live !== undefined;
};

// Injected turn generator matching streamAgent's shape; importing agent.routes directly here would close an import
// cycle.
export type TurnFn = (services: Services, input: TurnInput, signal: AbortSignal | undefined) => AsyncGenerator<AgentEvent>;

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

// Runs through the same detached turn-run pump a composer's turn uses, so /agent/attach can watch it; the pump folds a
// failed turn into an error frame and persists the transcript. Reduces that stream to the four values the loop needs.
const runIteration = async (services: Services, loop: Loop, turn: AgentTurn & { conversationId: string }, fn: TurnFn): Promise<IterationOutcome> => {
    const report: string[] = [];
    let usage: UsageFrame | undefined;
    let sessionId: string | undefined;
    let failure: string | undefined;
    // Transcript adoption starts before the provider runs, matching the send path's own order.
    const opened = openTurnTranscript(services, turn);
    const run = startTurnRun((input, signal) => fn(services, input, signal), turn, {
        before: opened,
        opening: (startedAt) => openingRows(turn, services.workspace.root, startedAt),
        transcript: (rows, steerRows) => recordTurnTranscript(services, turn, rows, steerRows),
    });
    if (run === undefined) {
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
// else broadcasts after the last one.
const publish = (loop: Loop, state: LoopState, iteration: number): void =>
    loopProjection.set(loop.conversationId, { state, iteration, maxIterations: loop.maxIterations, goal: loop.goal });

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
export const runLoop = async (services: Services, record: LoopRecord, fn: TurnFn): Promise<LoopSettlement> => {
    const { conversationId } = record;
    if (running.has(conversationId)) {
        return { state: "error", detail: "This agent is already looping.", iterations: record.iterations.length, report: "", costUsd: 0 };
    }
    const abort = new AbortController();
    running.set(conversationId, { abort });
    const tree = treeOf(services, record);
    // Creates the loop directory upfront so a `fresh` iteration isn't wasting its first move on mkdir.
    await mkdir(loopDirIn(services.workspace.root, conversationId), { recursive: true }).catch(() => undefined);

    let iteration = record.iterations.length;
    let spentUsd = record.iterations.reduce((total, entry) => total + (entry.costUsd ?? 0), 0);
    let stalls = 0;
    // Session to resume in `continue` mode; staying undefined in `fresh` mode is what makes it fresh.
    let sessionId = record.context === "continue" ? services.agents.sessionIdOf(conversationId) : undefined;
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
            publish(record, "running", iteration);
            const before = await treeDigest(tree);
            const turn: AgentTurn & { conversationId: string } = {
                prompt: briefForIteration(record, iteration),
                conversationId,
                // Marks that nobody is at a composer for this turn (AgentTurn.unattended): changes model defaults and
                // skips interactive prompt decorations.
                unattended: true,
                runRole: `loop-iteration`,
                ...(record.isolated ? { isolated: true } : {}),
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...(record.agent !== undefined ? { agent: record.agent } : {}),
                ...(record.harness !== undefined ? { harness: record.harness } : {}),
                ...(record.account !== undefined ? { account: record.account } : {}),
                ...(record.model !== undefined ? { model: record.model } : {}),
                ...(record.actsAs !== undefined ? { actsAs: record.actsAs } : {}),
                ...(record.worktreeBase !== undefined ? { worktreeBase: record.worktreeBase } : {}),
                ...(record.autoLand !== undefined ? { autoLand: record.autoLand } : {}),
            };
            const outcome = await runIteration(services, record, turn, fn);
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
        running.delete(conversationId);
    }
    const settled = ended ?? { state: "error" as const, detail: "loop ended without a verdict" };
    await services.loops
        .settle(conversationId, settled.state, Date.now(), settled.detail)
        .catch((error: unknown) => services.logger.warn({ err: error, conversationId }, "loop: settle failed"));
    publish(record, settled.state, iteration);
    return {
        state: settled.state,
        ...(settled.detail !== undefined ? { detail: settled.detail } : {}),
        iterations: iteration,
        report,
        costUsd: spentUsd,
        ...(document !== undefined ? { document } : {}),
    };
};

// Resumes loops still marked `running` after a restart (the manifest is the journal: `running` means no `settle`
// landed). RESUME_MAX caps repeat attempts, so a loop that reliably kills the daemon settles `error` instead.
const RESUME_MAX = 2;

export const resumeLoops = async (services: Services, fn: TurnFn, ownedByWorkflow: ReadonlySet<string> = new Set()): Promise<string[]> => {
    const resumed: string[] = [];
    for (const record of await services.loops.list()) {
        if (record.state !== "running" || running.has(record.conversationId) || ownedByWorkflow.has(record.conversationId)) {
            continue;
        }
        const counted = await services.loops.countResume(record.conversationId);
        if (counted === undefined) {
            continue;
        }
        if (counted.resumed > RESUME_MAX) {
            await services.loops.settle(
                record.conversationId,
                "error",
                Date.now(),
                `Abandoned after the daemon died under this loop ${counted.resumed} times.`,
            );
            publish(record, "error", record.iterations.length);
            services.logger.warn({ conversationId: record.conversationId }, "loop: abandoned after repeated daemon deaths");
            continue;
        }
        resumed.push(record.conversationId);
        void runLoop(services, counted, fn);
    }
    return resumed;
};
