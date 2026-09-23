import { createBackoff, sleep } from "@intentic/base/async";
import type { AgentHarness, AgentProvider, AttachFrame } from "@intentic/sandbox-contract";
import { SandboxHttpError } from "../../sandbox/client/sandboxHttpError";
import { type ProcedureInput, sandboxRpc } from "../../sandbox/client/sandboxRpc";
import { acquireStreamSlot } from "../../sandbox/client/streamBudget";
import type { ChatAttachment } from "../transcript/transcript";

// Attach reads a running turn's rows from the daemon and every change after (/agent/attach); the side channel
// (/agent/steer, /agent/stop, /agent/reply) sends to it. This file owns the connection, slot budget, reconnect
// backoff, and give-up rules; the Conversation decides what a fact means.

// What this window handed to a turn, kept so a refusal can put it back in the composer.
export interface SentMessage {
    readonly text: string;
    readonly attachments: readonly ChatAttachment[];
}

// One in-flight turn's streaming context: which run's rows render under which attribution, captured onto the
// session the stream mints.
export interface TurnContext {
    // The words this window sent, for a refusal to hand back; absent on a reattach, which typed nothing of its own.
    readonly sent?: SentMessage;
    // The run these rows belong to, as the daemon named it in the attach head.
    readonly run: string;
    readonly provider: AgentProvider;
    readonly account: string | undefined;
    readonly harness: AgentHarness;
}

// Head frame of an /agent/attach stream: the run's identity and its rows so far.
export type AttachHead = Extract<AttachFrame, { kind: "attached" }>;
// Everything after the head: a change to the rows, or a fact about the turn.
export type AttachEntry = Extract<AttachFrame, { kind: "patch" | "fact" }>;

// What a followed run needs from the conversation rendering it: whose turn the rows belong to, and where to
// put them.
export interface RunRenderer {
    // Runs on every attach head, fresh or re-attach, since each head carries the run's rows whole and replaces
    // what's held. Returns undefined to stand down when a send won the reattach race.
    attached(head: AttachHead): TurnContext | undefined;
    // One entry after the head. `replay` marks an entry already delivered to an earlier attach of this stream (at
    // or below the head's seq).
    entry(entry: AttachEntry, turn: TurnContext, replay: boolean): void;
}

// Renders a run by attaching, re-attaching on drops, until the daemon sends `end` or the run 404s (finished,
// stopped, or never started). Returns whether the stream ever engaged.
export const followRun = async (
    conversationId: string,
    // Run to attach to, when known; undefined asks the daemon for whatever is running (reattach).
    initialRun: string | undefined,
    renderer: RunRenderer,
    controller: AbortController,
    // Which daemon runs it (undefined=this box); reused every re-attach so a resumed stream stays on it.
    at: string | undefined,
): Promise<boolean> => {
    let run = initialRun;
    let attached = false;
    const ladder = createBackoff({ floorMs: 500, capMs: 5_000 });
    let turn: TurnContext | undefined;
    // Head's seq: a fact at or below it was already delivered to a previous attach of this stream.
    let replayThrough = 0;
    // Consecutive empty re-attaches; enough of them means treating the run as done, not looping forever.
    let idleRounds = 0;
    let delivered = 0;
    // Applies one attach frame. Returns undefined to keep draining, otherwise the value followRun itself returns:
    // this attach is over. A closure since `run`/`attached`/`turn` are loop state, not arguments.
    const applyFrame = (parsed: AttachFrame): boolean | undefined => {
        if (parsed.kind === `attached`) {
            // A newer turn started while disconnected; settle here instead of misrendering it.
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
        // A permit for holding a connection open for the turn's duration, since a few streaming agents would exhaust
        // the browser's per-origin connection limit (streamBudget.ts). Undefined means aborted while queued.
        const slot = await acquireStreamSlot(`attach`, controller.signal);
        if (slot === undefined) {
            return attached;
        }
        // Re-checked since acquiring a slot suspends; a stop landing during that must not be missed. Attaching on an
        // already-aborted signal would hang forever, since that event already fired.
        if (controller.signal.aborted) {
            slot();
            return attached;
        }
        let frames: AsyncIterable<AttachFrame>;
        try {
            frames = await sandboxRpc.agent.attach(
                { conversationId, ...(run !== undefined ? { run } : {}) },
                { signal: controller.signal, context: { at } },
            );
        } catch (error) {
            // The daemon refusing ends the follow (the run finished, stopped, or never started). A network drop between
            // attaches: an unengaged probe gives up (caller retries next reachability flip); an engaged stream backs off
            // and retries. Slot releases before any of them.
            slot();
            if (error instanceof SandboxHttpError || controller.signal.aborted || !attached) {
                return attached;
            }
            await sleep(ladder.next());
            continue;
        }
        ladder.reset();
        const before = delivered;
        try {
            for await (const frame of frames) {
                // A frame with no body says nothing; skipped rather than read as the end of the run.
                const parsed: unknown = frame;
                if (typeof parsed !== `object` || parsed === null) {
                    continue;
                }
                const ended = applyFrame(frame);
                if (ended !== undefined) {
                    return ended;
                }
            }
        } catch {
            // The stream broke mid-read, fall through and re-attach.
        } finally {
            // Slot releases however this attach ended: settled, superseded, torn, or returned mid-loop.
            slot();
        }
        // Reached only when the stream ended without `end`. No new entries either means nothing more is coming (done,
        // or a stream that never ends); back off, and give up after a few empty rounds.
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

// The side channel into a running turn, and what each message carries.
export interface TurnControl {
    readonly reply: ProcedureInput<`agent.reply`>;
    readonly steer: ProcedureInput<`agent.steer`>;
    readonly stop: ProcedureInput<`agent.stop`>;
}

// Sends a turn-control message to the conversation's own box, per followRun's addressing rule: the wrong daemon would
// report success for a turn still running elsewhere. True once the daemon took it.
export const postTurnControl = async <K extends keyof TurnControl>(at: string | undefined, control: K, input: TurnControl[K]): Promise<boolean> => {
    const options = { context: { at } };
    const send: { readonly [C in keyof TurnControl]: (input: TurnControl[C]) => Promise<unknown> } = {
        reply: (body) => sandboxRpc.agent.reply(body, options),
        steer: (body) => sandboxRpc.agent.steer(body, options),
        stop: (body) => sandboxRpc.agent.stop(body, options),
    };
    return send[control](input).then(
        () => true,
        () => false,
    );
};
