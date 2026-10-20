import { anySignal, createBackoff, sleep } from "@intentic/base/async";
import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { AttachFrame } from "@intentic/sandbox-contract/events/agent-events";
import { watchdogRecoveryDelay } from "../connection";
import { SandboxHttpError } from "../sandboxHttpError";
import { type ProcedureInput, sandboxRpc } from "../sandboxRpc";
import { acquireStreamSlot } from "../../../lib/streamBudget";
import type { ChatAttachment } from "../../../models/conversations/transcript/transcript";

// Attach reads a running turn's rows from the daemon and every change after (/agent/attach); the side channel
// (/agent/steer, /agent/reply) sends to it. This file owns the connection, slot budget, reconnect
// backoff, and give-up rules; the Conversation decides what a fact means.

// How long an attach may go without a single byte before it is taken for a dead connection and attached again. A turn
// can be quiet for minutes (a long build, a model thinking), but the daemon's stream keep-alive is a comment every 5 s,
// so a healthy connection is never silent for long; one that a sleeping laptop, a dropped Wi-Fi or a proxy left
// half-open says nothing at all and would otherwise hang the chat on its last row forever. Sized like the sandbox
// connection's patient watchdog (useSandboxLiveness.ts): six keep-alives missed, not one late.
export const ATTACH_SILENCE_MS = 30_000;

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

// What an attach asks for: the conversation, and the run it means or the run it means to follow on from, where known.
const attachInput = (conversationId: string, run: string | undefined, after: string | undefined): ProcedureInput<`agent.attach`> => {
    const input: ProcedureInput<`agent.attach`> = { conversationId };
    if (run !== undefined) {
        input.run = run;
    }
    if (after !== undefined) {
        input.after = after;
    }
    return input;
};

// How a follow ended: the stream engaged (true), the daemon said nothing runs (false), or it could not be asked at all
// (undefined): a network error before anything engaged, which is not "nothing is running". A first turn still running
// has no settled record to fall back on, so a caller reading that as false drew an empty chat over a live turn.
export type FollowEnd = boolean | undefined;

// One attach's opening: its frames, the follow's end when there is nothing to follow, or a retry after a drop.
type AttachOpening = { readonly frames: AsyncIterable<AttachFrame> } | { readonly end: FollowEnd } | { readonly retry: true };

// The daemon refusing ends the follow (the run finished, stopped, or never started), as does a stop. A network drop
// between attaches, or a connect the silence watchdog gave up on: an engaged stream backs off and retries; an unengaged
// probe gives up, saying it never reached the daemon (its caller retries).
const openAttach = async (
    input: ProcedureInput<`agent.attach`>,
    controller: AbortController,
    attempt: Silence,
    at: string | undefined,
    attached: boolean,
): Promise<AttachOpening> => {
    try {
        return { frames: await sandboxRpc.agent.attach(input, { signal: attempt.signal, context: { at, heard: attempt.heard } }) };
    } catch (error) {
        if (error instanceof SandboxHttpError || controller.signal.aborted) {
            return { end: attached };
        }
        return attached ? { retry: true } : { end: undefined };
    }
};

// One attach's silence watchdog: its signal is the follow's own and the watchdog's cut together, and anything heard
// from the daemon (a frame, a keep-alive's bytes) puts the cut off again.
interface Silence {
    readonly signal: AbortSignal;
    readonly heard: () => void;
    // Whether this attach ended because it went silent, rather than because it closed, broke or was stopped.
    readonly cut: () => boolean;
    readonly dispose: () => void;
}

const watchSilence = (controller: AbortController): Silence => {
    const silence = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (delayMs = ATTACH_SILENCE_MS): void => {
        clearTimeout(timer);
        const dueAt = performance.now() + delayMs;
        timer = setTimeout(() => {
            // A main thread that stalled past the deadline says nothing about the connection: bytes it has queued re-arm
            // this before the grace runs out (connection.ts).
            const grace = watchdogRecoveryDelay(performance.now() - dueAt);
            if (grace > 0) {
                arm(grace);
                return;
            }
            silence.abort();
        }, delayMs);
    };
    // Armed from before the connect, so a connect that hangs on a dead tunnel trips it too.
    arm();
    return {
        signal: anySignal(controller.signal, silence.signal),
        heard: () => {
            if (!silence.signal.aborted) {
                arm();
            }
        },
        cut: () => silence.signal.aborted && !controller.signal.aborted,
        dispose: () => clearTimeout(timer),
    };
};

// A permit for holding a connection open for the turn's duration, since a few streaming agents would exhaust the
// browser's per-origin connection limit (streamBudget.ts). Undefined means stopped while queued. The stop is checked
// again once the permit is held, since waiting for it suspends and a stop landing then must not be missed: attaching
// on an already-aborted signal would hang forever, since that event already fired.
const takeSlot = async (signal: AbortSignal): Promise<(() => void) | undefined> => {
    const slot = await acquireStreamSlot(`attach`, signal);
    if (slot !== undefined && signal.aborted) {
        slot();
        return undefined;
    }
    return slot;
};

// Reads one attach's frames until the run ends there (the value followRun returns), or undefined once the stream stops
// without saying so: closed, broken mid-read, or cut for silence. Every frame counts as hearing from the daemon.
const drain = async (
    frames: AsyncIterable<AttachFrame>,
    heard: () => void,
    apply: (frame: AttachFrame) => boolean | undefined,
): Promise<boolean | undefined> => {
    try {
        for await (const frame of frames) {
            heard();
            // A frame with no body says nothing; skipped rather than read as the end of the run.
            const parsed: unknown = frame;
            if (typeof parsed !== `object` || parsed === null) {
                continue;
            }
            const ended = apply(frame);
            if (ended !== undefined) {
                return ended;
            }
        }
    } catch {
        // allow(silent-catch): a stream that broke mid-read is a drop like any other; the caller attaches again.
        return undefined;
    }
    return undefined;
};

// Renders a run by attaching, re-attaching on drops, until the daemon sends `end` or the run 404s (finished,
// stopped, or never started). Returns whether the stream ever engaged (FollowEnd).
export const followRun = async (
    conversationId: string,
    // Run to attach to, when known; undefined asks the daemon for whatever is running (reattach).
    initialRun: string | undefined,
    renderer: RunRenderer,
    controller: AbortController,
    // Which daemon runs it (undefined=this box); reused every re-attach so a resumed stream stays on it.
    at: string | undefined,
    // A run this window already saw end: the daemon then opens on the run after it, waiting a moment for the one the
    // conversation's queue starts next (AttachTurnSchema.after), where asking without it would find nothing yet.
    after?: string,
): Promise<FollowEnd> => {
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
        const slot = controller.signal.aborted ? undefined : await takeSlot(controller.signal);
        if (slot === undefined) {
            return attached;
        }
        const attempt = watchSilence(controller);
        const opening = await openAttach(attachInput(conversationId, run, after), controller, attempt, at, attached);
        if (!(`frames` in opening)) {
            // Slot releases before the follow ends or backs off.
            attempt.dispose();
            slot();
            if (`end` in opening) {
                return opening.end;
            }
            // A stop during the wait ends it there and then (the loop's head reads the abort), rather than after up to
            // the ladder's cap of a backoff nobody is waiting for.
            await sleep(ladder.next(), { signal: controller.signal });
            continue;
        }
        ladder.reset();
        const before = delivered;
        let ended: boolean | undefined;
        try {
            ended = await drain(opening.frames, attempt.heard, applyFrame);
        } finally {
            // Slot releases however this attach ended: settled, superseded, torn, or returned mid-loop.
            attempt.dispose();
            slot();
        }
        if (ended !== undefined) {
            return ended;
        }
        // Reached only when the stream ended without `end`. One cut for silence was a dead connection, not a quiet run,
        // so like one that delivered rows it attaches again at once. No new entries otherwise means nothing more is
        // coming (done, or a stream that never ends); back off, and give up after a few empty rounds.
        if (delivered !== before || attempt.cut()) {
            idleRounds = 0;
            continue;
        }
        idleRounds += 1;
        if (idleRounds >= 3) {
            return attached;
        }
        await sleep(ladder.next(), { signal: controller.signal });
    }
};

// The side channel into a running turn, and what each message carries.
export interface TurnControl {
    readonly reply: ProcedureInput<`agent.reply`>;
}

// Sends a turn-control message to the conversation's own box, per followRun's addressing rule: the wrong daemon would
// report success for a turn still running elsewhere. True once the daemon took it.
export const postTurnControl = async <K extends keyof TurnControl>(at: string | undefined, control: K, input: TurnControl[K]): Promise<boolean> => {
    const options = { context: { at } };
    const send: { readonly [C in keyof TurnControl]: (input: TurnControl[C]) => Promise<unknown> } = {
        reply: (body) => sandboxRpc.agent.reply(body, options),
    };
    return send[control](input).then(
        () => true,
        () => false,
    );
};
