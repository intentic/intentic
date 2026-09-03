import { createBackoff, sleep } from "@intentic/base/async";
import { type AgentHarness, type AgentProvider, type AttachFrame, sseData, sseFrames } from "@intentic/sandbox-contract";
import { jsonBody } from "../sandbox/jsonBody";
import { sandboxRequestVia } from "../sandbox/sandboxClient";
import { acquireStreamSlot } from "../sandbox/streamBudget";

/* HOW THIS WINDOW TALKS TO A RUNNING TURN. A turn EXECUTES as a detached run on the sandbox daemon (POST /agent
 * starts it; the platform is not in the path) and a tab merely renders it: /agent/attach hands over the run's
 * rows so far and then every change to them as it lands, and the same stream serves a reload, a second window,
 * another device, or a probe hunting a run the daemon restarted. The side channel (/agent/steer · /agent/stop ·
 * /agent/reply) is the other direction, messages TO a turn already running.
 *
 * All of it is stateless about the conversation: the rows are the daemon's, what to do about a fact is the
 * Conversation's. This file owns only the connection, the slot budget, the reconnect backoff, and the give-up
 * rules. */

// One in-flight turn's streaming context: which run's rows are being rendered under which attribution, the
// provider/account/harness serving the turn, captured onto the session the stream mints.
export interface TurnContext {
    // The turn's user bubble, where a refused turn's words are taken back out from.
    readonly userMessageId: number;
    // The run these rows belong to, as the daemon named it in the attach head.
    readonly run: string;
    readonly provider: AgentProvider;
    readonly account: string | undefined;
    readonly harness: AgentHarness;
}

// The head frame of an /agent/attach stream: the run's identity and its rows so far.
export type AttachHead = Extract<AttachFrame, { kind: "attached" }>;
// Everything after it: a change to the rows, or a fact about the turn.
export type AttachEntry = Extract<AttachFrame, { kind: "patch" | "fact" }>;

/* What a followed run needs from the conversation rendering it: whose turn the rows belong to and where to put
 * them. */
export interface RunRenderer {
    // Runs at EVERY attach head, a fresh attach and every re-attach alike, because each head carries the run's
    // rows whole and they replace what this window holds for the run. The send path returns the context it
    // already prepared; the reattach path adopts the turn, or returns undefined to stand down when a send won
    // the race.
    attached(head: AttachHead): TurnContext | undefined;
    // One entry after the head. `replay` says the entry was already delivered to an earlier attach of this
    // stream (a fact at or below the head's seq): the daemon replays facts so a window joining late learns
    // them, and a window that already applied them is told so.
    entry(entry: AttachEntry, turn: TurnContext, replay: boolean): void;
}

/* Render a run by attaching to it, re-attaching whenever the stream drops, until the daemon says `end` (the run
 * settled, every entry delivered) or the run disappears (404: finished past retention, stopped, or never
 * started). Returns whether the stream ever engaged (a head arrived and `attached` produced a context). */
export const followRun = async (
    conversationId: string,
    // The run to attach to, when the caller already knows it (the send path just started it). Undefined asks
    // the daemon for whatever is running for this conversation, the reattach path.
    initialRun: string | undefined,
    renderer: RunRenderer,
    controller: AbortController,
    /* WHICH DAEMON IS RUNNING IT: undefined for the box this browser is pointed at, a sandbox id for a
     * conversation homed elsewhere (Conversation.box). The attach is an ordinary authenticated request and the
     * bearer store is keyed by sandbox already, so following a turn in another box costs this argument and
     * nothing else. It rides every re-attach in the loop below, so a stream that drops and resumes cannot come
     * back pointed at the active box.
     *
     * Required rather than defaulted, in a signature where every other argument is: a stream aimed at the wrong
     * daemon renders someone else's turn into this transcript, so "which box" is a question every caller answers
     * out loud. */
    at: string | undefined,
): Promise<boolean> => {
    let run = initialRun;
    let attached = false;
    const ladder = createBackoff({ floorMs: 500, capMs: 5_000 });
    let turn: TurnContext | undefined;
    // The head's seq: a fact at or below it was delivered to a previous attach of this stream.
    let replayThrough = 0;
    // Consecutive re-attaches that returned no new entries and no `end`. A run that keeps answering empty is
    // done with nothing left to stream (or never terminates its stream), so give up after a few rounds
    // rather than tight-looping the daemon at network speed. Reset the moment real progress arrives.
    let idleRounds = 0;
    let delivered = 0;
    /* Apply one attach frame. Returns undefined while the stream should keep being drained, otherwise the
     * value followRun itself answers with: this attach is over. A closure rather than a free function because
     * `run`, `attached` and `turn` ARE the loop's state, not arguments. */
    const applyFrame = (parsed: AttachFrame): boolean | undefined => {
        if (parsed.kind === `attached`) {
            // A head naming a different run than the cursor's means a newer turn started while this tab was
            // disconnected, that turn belongs at a different transcript position (after ITS user message), so
            // this stream settles rather than misrendering it here.
            if (run !== undefined && parsed.run !== run) {
                return attached;
            }
            run = parsed.run;
            replayThrough = parsed.seq;
            turn = renderer.attached(parsed);
            if (turn === undefined) {
                return false;
            }
            attached = true;
        } else if (parsed.kind === `patch` || parsed.kind === `fact`) {
            delivered += 1;
            if (turn !== undefined) {
                renderer.entry(parsed, turn, parsed.seq <= replayThrough);
            }
        } else if (parsed.kind === `end`) {
            return attached;
        }
        return undefined;
    };
    for (;;) {
        if (controller.signal.aborted) {
            return attached;
        }
        /* A permit for this attach, because it is about to hold a whole CONNECTION open for as long as the
         * turn runs. A browser allows six per origin on http/1.1, so without a budget four or five
         * streaming agents leave every window of this app unable to make an ordinary request at all, see
         * streamBudget.ts. Unbounded (so this resolves on the spot) wherever the transport multiplexes,
         * which is h2 on the certified loopback and on the tunnel. Undefined means this conversation was
         * aborted while queued. */
        const slot = await acquireStreamSlot(`attach`, controller.signal);
        if (slot === undefined) {
            return attached;
        }
        /* Re-checked because the acquire above is a suspension point, and a stop landing inside it must not
         * be overtaken. Attaching on a signal that has ALREADY aborted parks forever rather than failing:
         * the body's producer wires its teardown to that signal, so it has missed the only event that would
         * ever have ended the stream, and this read waits on it for the life of the tab. */
        if (controller.signal.aborted) {
            slot();
            return attached;
        }
        let response: Response;
        try {
            response = await sandboxRequestVia(at, `/agent/attach`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                signal: controller.signal,
                body: JSON.stringify({ conversationId, ...(run !== undefined ? { run } : {}) }),
            });
        } catch {
            // Network drop between attaches. A probe that never engaged gives up (its caller retries on
            // the next reachability flip); an engaged stream backs off and retries, the turn may well
            // still be running, and the next head brings its rows back whole. The slot goes back first
            // either way: a stream that is not open must not hold one across the backoff.
            slot();
            if (controller.signal.aborted || !attached) {
                return attached;
            }
            await sleep(ladder.next());
            continue;
        }
        if (!response.ok || !response.body) {
            slot();
            return attached;
        }
        ladder.reset();
        const before = delivered;
        try {
            for await (const frame of sseFrames(response.body)) {
                const parsed = sseData(frame) as AttachFrame | undefined;
                if (parsed === undefined || typeof parsed !== `object`) {
                    continue;
                }
                const ended = applyFrame(parsed);
                if (ended !== undefined) {
                    return ended;
                }
            }
        } catch {
            // The stream broke mid-read, fall through and re-attach.
        } finally {
            // However this attach ended, settled, superseded, torn, or returned from inside the loop,
            // the connection is done and the next stream may have it.
            slot();
        }
        // Reached only when the stream ENDED WITHOUT an `end` frame (a clean `end` returns above). If it also
        // delivered nothing new, the run has no more for us, a done run whose tail we already hold, or one
        // whose stream never terminates, so an immediate re-attach would spin. Back off, and after a few
        // empty rounds give up: what we hold is complete, and a live turn would have delivered something
        // (resetting this). Real progress OR a fresh `end` keep the reconnect loop responsive.
        if (delivered === before) {
            idleRounds += 1;
            if (idleRounds >= 3) {
                return attached;
            }
            await sleep(ladder.next());
        } else {
            idleRounds = 0;
        }
    }
};

// Posts a turn-control message (steer, stop, reply) to the daemon running the turn: `at` is the conversation's
// own box, on followRun's terms above, because a stop that reached the wrong daemon would report success for a
// turn still running. Returns whether it succeeded.
export const postTurnControl = async (at: string | undefined, path: string, body: unknown): Promise<boolean> => {
    try {
        const response = await sandboxRequestVia(at, path, jsonBody(`POST`, body));
        return response.ok;
    } catch {
        return false;
    }
};
