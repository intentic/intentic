import { type AgentEvent, type AgentHarness, type AgentProvider, type AttachFrame, sseData, sseFrames } from "@intentic/sandbox-contract";
import { sandboxRequest } from "../sandbox/sandboxClient";
import { jsonBody } from "../sandbox/jsonBody";
import { acquireStreamSlot } from "../sandbox/streamBudget";

/* HOW THIS WINDOW TALKS TO A RUNNING TURN. A turn EXECUTES as a detached run on the sandbox daemon (POST /agent
 * starts it; the platform is not in the path) and a tab merely renders it: /agent/attach replays the run's frame
 * log and then follows it live, resumable by seq cursor when the connection drops, and the same stream serves a
 * reload, a second window, another device, or a probe hunting a run the daemon restarted. The side channel
 * (/agent/steer · /agent/stop · /agent/reply) is the other direction — messages TO a turn already running.
 *
 * All of it is stateless about the conversation: what a frame MEANS is the reducer's, and what to do about it is
 * the Conversation's. This file owns only the connection — the slot budget, the reconnect backoff, the replay
 * boundary, and the give-up rules. */

// One in-flight turn's streaming context: which run's frames are being rendered under which attribution — the
// provider/account/harness serving the turn, captured onto the session the stream mints.
export interface TurnContext {
    // The turn's user bubble — the checkpoint frame anchors its restore affordance here. The turn's CURRENT
    // bubble is not here: which bubble the agent is writing into moves with every block boundary and card, so
    // it belongs to the reducer's state (TurnState.bubbleId) rather than to a context the caller holds.
    readonly userMessageId: number;
    readonly provider: AgentProvider;
    readonly account: string | undefined;
    readonly harness: AgentHarness;
}

// The head frame of an /agent/attach stream — the run's identity plus what a non-initiating window needs to
// synthesize the turn locally (user bubble from the prompt, elapsed readout from the start time).
export type AttachHead = Extract<AttachFrame, { kind: "attached" }>;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* What a followed run needs from the conversation rendering it: whose turn the frames belong to and where to
 * put them. */
export interface RunRenderer {
    // Runs once, at the first attach head. The send path returns the context it already prepared; the reattach
    // path synthesizes bubbles from the head — or returns undefined to stand down when a send won the race.
    ensureTurn(head: AttachHead): TurnContext | undefined;
    frame(event: AgentEvent, turn: TurnContext): void;
}

/* Render a run by attaching to it, re-attaching from the seq cursor whenever the stream drops, until the
 * daemon says `end` (the run settled — every frame delivered) or the run disappears (404: finished past
 * retention, stopped, or never started). Returns whether the stream ever engaged (a head arrived and
 * ensureTurn produced a context). */
export const followRun = async (
    conversationId: string,
    // The run to attach to, when the caller already knows it (the send path just started it). Undefined asks
    // the daemon for whatever is running for this conversation — the reattach path.
    initialRun: string | undefined,
    renderer: RunRenderer,
    controller: AbortController,
): Promise<boolean> => {
    // The resume cursor, held here because nothing outside this loop reads it: `run` latches the run being
    // rendered, `after` the last seq delivered, and every re-attach picks up from the pair.
    let run = initialRun;
    let after = 0;
    let attached = false;
    let retryMs = 500;
    let turn: TurnContext | undefined;
    // Consecutive re-attaches that returned no new frames and no `end`. A run that keeps answering empty is
    // done with nothing left to stream (or never terminates its stream), so give up after a few rounds
    // rather than tight-looping the daemon at network speed. Reset the moment real progress arrives.
    let idleRounds = 0;
    for (;;) {
        if (controller.signal.aborted) {
            return attached;
        }
        /* A slot for this attach, because it is about to hold a whole CONNECTION open for as long as the
         * turn runs. A browser allows six per origin on http/1.1, so without a budget four or five
         * streaming agents leave the tab unable to make an ordinary request at all — see streamBudget.ts.
         * Unbounded (so this resolves on the spot) wherever the transport multiplexes, which is h2 on the
         * certified loopback and on the tunnel. Undefined means this conversation was aborted while
         * queued. */
        const slot = await acquireStreamSlot(controller.signal);
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
            response = await sandboxRequest(`/agent/attach`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                signal: controller.signal,
                body: JSON.stringify({
                    conversationId,
                    ...(run !== undefined ? { run } : {}),
                    after,
                }),
            });
        } catch {
            // Network drop between attaches. A probe that never engaged gives up (its caller retries on
            // the next reachability flip); an engaged stream backs off and retries — the turn may well
            // still be running, and the cursor resumes it exactly where this tab left off. The slot goes
            // back first either way: a stream that is not open must not hold one across the backoff.
            slot();
            if (controller.signal.aborted || !attached) {
                return attached;
            }
            await delay(retryMs);
            retryMs = Math.min(retryMs * 2, 5_000);
            continue;
        }
        if (!response.ok || !response.body) {
            slot();
            return attached;
        }
        retryMs = 500;
        const beforeAfter = after;
        try {
            for await (const frame of sseFrames(response.body)) {
                const parsed = sseData(frame) as AttachFrame | undefined;
                if (parsed === undefined || typeof parsed !== `object`) {
                    continue;
                }
                if (parsed.kind === `attached`) {
                    // A head naming a different run than the cursor's means a newer turn started while
                    // this tab was disconnected — that turn belongs at a different transcript position
                    // (after ITS user message), so this stream settles rather than misrendering it here.
                    if (run !== undefined && parsed.run !== run) {
                        return attached;
                    }
                    run = parsed.run;
                    turn ??= renderer.ensureTurn(parsed);
                    if (turn === undefined) {
                        return false;
                    }
                    attached = true;
                } else if (parsed.kind === `frame`) {
                    after = parsed.seq;
                    if (turn !== undefined) {
                        renderer.frame(parsed.event, turn);
                    }
                } else if (parsed.kind === `end`) {
                    return attached;
                }
            }
        } catch {
            // The stream broke mid-read — fall through and re-attach from the cursor.
        } finally {
            // However this attach ended — settled, superseded, torn, or returned from inside the loop —
            // the connection is done and the next stream may have it.
            slot();
        }
        // Reached only when the stream ENDED WITHOUT an `end` frame (a clean `end` returns above). If it also
        // delivered nothing new (cursor unmoved), the run has no more for us — a done run whose tail we
        // already hold, or one whose stream never terminates — so an immediate re-attach would spin. Back off,
        // and after a few empty rounds give up: what we hold is complete, and a live turn would have advanced
        // the cursor (resetting this). Real progress OR a fresh `end` keep the reconnect loop responsive.
        if (after === beforeAfter) {
            idleRounds += 1;
            if (idleRounds >= 3) {
                return attached;
            }
            await delay(retryMs);
            retryMs = Math.min(retryMs * 2, 5_000);
        } else {
            idleRounds = 0;
        }
    }
};

// Posts a turn-control message to the platform side-channel, which relays it to the sandbox daemon.
// Returns whether it succeeded.
export const postTurnControl = async (path: string, body: unknown): Promise<boolean> => {
    try {
        const response = await sandboxRequest(path, jsonBody(`POST`, body));
        return response.ok;
    } catch {
        return false;
    }
};
