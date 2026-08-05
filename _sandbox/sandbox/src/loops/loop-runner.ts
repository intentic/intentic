import { mkdir } from "node:fs/promises";
import type { AgentEvent, AgentTurn, Loop, LoopDocument, LoopIteration, LoopRecord, LoopState } from "@intentic/sandbox-contract";
import { sumUsage, type UsageFrame } from "../agent/turn-usage.js";
import type { Services } from "../composition.js";
import { openTurnTranscript, recordTurnTranscript } from "../sessions/turn-transcript.js";
import { briefForIteration, loopDirIn } from "./loop-brief.js";
import { treeDigest } from "./loop-progress.js";
import { evaluateStop } from "./loop-stop.js";
import { loopProjection } from "./loop-state.js";

/* THE PUMP — run a conversation's turn, ask whether the goal is met, and if not run it again.
 *
 * DAEMON-SIDE, and that is the single decision this module exists to enforce. A turn is already detached from
 * every client (turn-runs.ts), so one turn survives a closed browser without help — which is exactly why the
 * acceptance extension can drive its fan-out from the browser and get away with it. A SEQUENCE cannot: driven
 * from a tab, iteration 4 never starts because the thing that would have started it was a closed laptop. Loops
 * therefore live where the scheduler lives, and the browser only ever watches.
 *
 * WHAT IT DRIVES IS AN ORDINARY TURN. `streamAgent` is injected rather than imported (the same cycle-break the
 * automations scheduler and turn-runs both make), and what goes into it is the same AgentTurn a composer sends.
 * So a looping agent gets the fleet card, the worktree, the transcript, the cost ledger, the Stop button and
 * the /agents page for free, and nothing in this file has an opinion about any of them.
 *
 * THE FOUR WAYS IT STOPS BESIDES SUCCEEDING are the whole risk surface of the feature, and they are checked in
 * this order every iteration: the user asked it to stop, the spend ceiling is reached, the tree has not moved
 * for `stallLimit` iterations, the iteration budget is spent. A loop is the first thing in this sandbox that
 * can spend money with nobody pressing anything between turns, so none of them is optional and none of them is
 * a warning — each one ends the loop and says which it was.
 */

// A loop that is running right now, keyed by conversation. A module singleton for the same reason the
// scheduler's `inFlight` is one: the routes, the boot resume and the tests all have to see the same set, and a
// second pump on one conversation would have two drivers racing the same worktree and the same turn mutex.
const running = new Map<string, { readonly abort: AbortController }>();

export const loopRunning = (conversationId: string): boolean => running.has(conversationId);

/* Ask a running loop to stop after the iteration in flight — deliberately NOT a turn abort.
 *
 * Stopping a loop means "do not start another one", not "throw away what is running". A user watching iteration
 * 6 do good work must be able to call it the last one without losing it; abandoning the work outright is
 * /agent/stop, and pressing both is the ordinary way to do that. Returns false when nothing was looping.
 */
export const stopLoop = (conversationId: string): boolean => {
    const live = running.get(conversationId);
    live?.abort.abort();
    return live !== undefined;
};

// The turn generator, injected — streamAgent's shape. Same reason the scheduler takes its WakeFn: importing
// agent.routes here would close a cycle through the workspace events it emits.
export type TurnFn = (services: Services, input: AgentTurn, signal: AbortSignal | undefined) => AsyncGenerator<AgentEvent>;

// The tree an iteration works in — an isolated loop's own checkout, or the workspace itself. What the stop
// command runs against and what the stall detector digests, so the two can never disagree about which tree the
// loop is talking about.
const treeOf = (services: Services, loop: Loop): string =>
    loop.isolated ? services.agentWorktrees.conversationDir(loop.conversationId) : services.workspace.root;

interface IterationOutcome {
    readonly report: string;
    readonly usage: UsageFrame | undefined;
    readonly sessionId: string | undefined;
    readonly failure: string | undefined;
}

// Run one iteration's turn and reduce its frame stream to the four things the loop needs from it. The frames
// themselves go to the transcript, like every other headless driver's do — this keeps only what decides what
// happens next.
const runIteration = async (services: Services, loop: Loop, turn: AgentTurn & { conversationId: string }, fn: TurnFn): Promise<IterationOutcome> => {
    const events: AgentEvent[] = [];
    const report: string[] = [];
    let usage: UsageFrame | undefined;
    let sessionId: string | undefined;
    let failure: string | undefined;
    await openTurnTranscript(services, turn);
    try {
        for await (const event of fn(services, turn, undefined)) {
            events.push(event);
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
    } catch (error) {
        // A thrown turn does NOT end the loop — see the call site. It is recorded as the iteration's outcome and
        // the next iteration gets its chance, because a turn that died on a provider blip is the single most
        // ordinary thing a loop is there to ride out.
        failure = error instanceof Error ? error.message : "loop iteration failed";
        services.logger.warn({ err: error, conversationId: loop.conversationId }, "loop iteration failed");
    } finally {
        await recordTurnTranscript(services, turn, events);
    }
    return { report: report.join(""), usage, sessionId, failure };
};

// Publish where the loop stands to every fleet card. Called at each iteration boundary and once more at the
// end — the last one is the whole reason loop-state carries a change notification, since no turn frame follows
// it to broadcast the roster.
const publish = (loop: Loop, state: LoopState, iteration: number): void =>
    loopProjection.set(loop.conversationId, { state, iteration, maxIterations: loop.maxIterations, goal: loop.goal });

/* HOW A LOOP ENDED, handed back to whoever started it.
 *
 * A route that acked and walked away ignores this; a workflow step is entirely made of it. Returned rather
 * than re-read from the store because this is the one moment everything is already in hand — re-reading the
 * manifest to learn what the call you just awaited did is both slower and a chance to disagree with it.
 */
export interface LoopSettlement {
    readonly state: LoopState;
    readonly detail?: string;
    readonly iterations: number;
    // The last iteration's closing assistant text. The output of a `none` loop, and the evidence anything
    // downstream has when no document was asked for.
    readonly report: string;
    // What the whole loop cost, summed from its iterations' own usage frames. Returned rather than left to be
    // re-read off the manifest: the caller that has to know (a workflow charging a run-level ceiling) would
    // otherwise re-open a file to learn the total of a call it just awaited.
    readonly costUsd: number;
    // The last VALID document the loop read, whatever it said. Present even on a loop that ended `exhausted`,
    // because "here is the last thing it managed to conclude" is worth more than a blank.
    readonly document?: LoopDocument;
}

/* Drive one loop to completion. Resolves when the loop ends, however it ends; it never rejects, because a loop
 * that fails has a state to say so with and both callers (a route that has already acked, a workflow step)
 * would only have to turn a rejection back into one.
 */
export const runLoop = async (services: Services, record: LoopRecord, fn: TurnFn): Promise<LoopSettlement> => {
    const { conversationId } = record;
    if (running.has(conversationId)) {
        return { state: "error", detail: "This agent is already looping.", iterations: record.iterations.length, report: "", costUsd: 0 };
    }
    const abort = new AbortController();
    running.set(conversationId, { abort });
    const tree = treeOf(services, record);
    // The loop's own directory, made before the first iteration is told to write into it — a `fresh` iteration
    // asked to read a progress file whose directory does not exist wastes its opening move on mkdir.
    await mkdir(loopDirIn(services.workspace.root, conversationId), { recursive: true }).catch(() => undefined);

    let iteration = record.iterations.length;
    let spentUsd = record.iterations.reduce((total, entry) => total + (entry.costUsd ?? 0), 0);
    let stalls = 0;
    // The session to resume, carried between iterations in `continue` mode. Undefined in `fresh` mode forever —
    // that absence IS the mode: no session id means the provider opens a new one against the same worktree.
    let sessionId = record.context === "continue" ? services.agents.sessionIdOf(conversationId) : undefined;
    // What the loop hands back. Kept across iterations rather than taken from the last one, because the last
    // iteration of a loop that ran out of road is often the one that produced the least — an `exhausted` loop
    // should still return the best document it ever wrote.
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
                /* NOBODY IS AT A COMPOSER, which is what this flag means and what a loop is. It was missing,
                 * and the cost was not only the model defaults it selects (see AgentTurn.unattended): every
                 * iteration was also treated as a person's question by the turn's own prompt decorations. The
                 * pre-injected workspace retrieval ran with THIS BRIEF as its query — "# Iteration 1 of at most
                 * 3 / You are one iteration of a loop that repeats until a goal is met…" — and pasted a
                 * `## Retrieved workspace context` block, searched for that, on top of the step's real
                 * instructions. The first message of every workflow step opened with a page of it. */
                unattended: true,
                ...(record.isolated ? { isolated: true } : {}),
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...(record.agent !== undefined ? { agent: record.agent } : {}),
                ...(record.harness !== undefined ? { harness: record.harness } : {}),
                ...(record.model !== undefined ? { model: record.model } : {}),
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
            /* The stop check runs even on an iteration that ERRORED, and that is not an oversight: a turn can
             * fail on its closing frame having already made the change that meets the goal, and a loop that
             * skipped the check there would spend another iteration re-doing finished work. The check is cheap
             * and it is the authority — the turn's own fate is not. */
            const verdict = await evaluateStop(services, record, {
                iteration,
                cwd: tree,
                report: outcome.report,
                signal: abort.signal,
            });
            document = verdict.document ?? document;
            const entry: LoopIteration = {
                n: iteration,
                at: Date.now(),
                outcome: verdict.done ? "done" : outcome.failure !== undefined ? "error" : "continue",
                changed,
                /* THE TURN'S FAILURE OUTRANKS THE CHECK'S VERDICT, unless the check says the goal was met.
                 *
                 * The two disagree in a specific, common way: a turn the provider refused writes nothing, so
                 * the completion check reports "no output file — the iteration ended without writing
                 * iteration-1.json". That is true and it is the CONSEQUENCE; the cause is a sentence the
                 * provider already handed us. Preferring the verdict buried it, and a workflow step whose
                 * model was refused ("your organization has disabled Claude subscription access") recorded
                 * two rounds of a missing file instead — the reason nowhere, on any surface. */
                ...(verdict.done
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
            if (verdict.done) {
                ended = { state: "done", ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}) };
                break;
            }
            // Checked AFTER the iteration is recorded, so the history shows the unchanged runs that earned the
            // verdict — a stalled loop whose rows do not show the stall is an accusation with no evidence.
            if (stalls >= record.stallLimit) {
                /* A loop that stalled because every turn was REFUSED says so. Otherwise the step's one-line
                 * detail — the sentence the run view and the fleet card both read — is "3 iterations in a row
                 * changed nothing", which describes a wedged agent and hides a provider that never ran one. */
                ended = {
                    state: "stalled",
                    detail:
                        outcome.failure === undefined
                            ? `${stalls} iterations in a row changed nothing in the tree.`
                            : `${stalls} iterations in a row changed nothing — the last one failed: ${outcome.failure}`,
                };
            }
        }
    } catch (error) {
        // Only the loop's own machinery reaches here — a failed digest, a store write that could not land. An
        // iteration's own failure is an iteration outcome and never gets this far.
        ended = { state: "error", detail: error instanceof Error ? error.message : "loop failed" };
        services.logger.error({ err: error, conversationId }, "loop failed");
    } finally {
        // In `finally` and alone in it, because this is the one thing that must happen on every path: a leaked
        // entry here means the conversation can never be looped again for as long as the daemon lives.
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

/* THE BOOT PASS — every loop the daemon died under, picked back up.
 *
 * The loops manifest is its own journal: a record still marked `running` when this runs is, by construction, a
 * loop no `settle` ever reached, and the container is recreated on every sandbox update, every environment
 * approval and every dev swap — so intentic's own flows are the main thing that kills loops. Without this, "the
 * user approved a Dockerfile change" and "the twelve-iteration loop silently stopped at four" are the same
 * event.
 *
 * The resume counter is what keeps it safe. A loop whose iteration reliably takes the daemon with it (an OOM in
 * the test it keeps running) would otherwise come back on every boot forever; past RESUME_MAX it is settled as
 * `error` and left alone, with the history saying exactly that.
 */
const RESUME_MAX = 2;

export const resumeLoops = async (services: Services, fn: TurnFn): Promise<string[]> => {
    const resumed: string[] = [];
    for (const record of await services.loops.list()) {
        if (record.state !== "running" || running.has(record.conversationId)) {
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
