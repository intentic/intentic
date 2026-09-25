import { sleep } from "@intentic/base/async";
import {
    type ConversationQueue,
    deriveTitle,
    type EditorContext,
    mentionPaths,
    type MessageReceipt,
    type PermissionMode,
    type QueuedMessage,
    type ResumeRouting,
    type TurnFact,
} from "@intentic/sandbox-contract";
import { errorMessage } from "@intentic/ui/async";
import { computed, ref, shallowRef } from "vue";
import { uuid } from "../../../lib/uuid";
import { orRefusal, SandboxHttpError } from "../../sandbox/client/sandboxHttpError";
import { type ProcedureInput, sandboxRpc } from "../../sandbox/client/sandboxRpc";
import type { PendingAttachment } from "../drafts/useChatAttachments";
import { accountIntent, resumes, type SessionRef, type TurnSettings, turnRequestBody } from "../run/turnRequest";
import { supportsRoute } from "../../sandbox/overview/useDaemonRoutes";
import { type AttachHead, followRun, type SentMessage, type TurnContext } from "../run/turnStream";
import { invalidateAgentTranscript } from "../transcript/agentTranscript";
import { type ChatAttachment, continuationFor, isNudgeText } from "../transcript/transcript";
import type { Conversation } from "./conversation";
import { accepted, advance, IDLE, type RunEvent, type RunPhase } from "./runPhase";

// One conversation's runs, as this window drives them: a message is sent (opened, then taken at the daemon's ack),
// followed while it streams or waits on a card, and settled, stopped or abandoned; a turn this window never opened is
// attached to by its run. Where a run stands is one value (runPhase.ts). What waits for the next turn is the daemon's
// queue, the same for every window (Conversation.queue); nothing here holds words of its own.

// A turn this window has opened and not yet handed to the daemon: its drawn bubble, its abort, the session it resumes.
interface OpenedTurn {
    readonly bubble: number;
    readonly controller: AbortController;
    readonly resume: SessionRef | undefined;
}

// A message sent again under the same id while no answer comes back: the daemon answers a resend with what it did the
// first time, so trying again can never deliver the words twice. Bounds a network blip, not an outage.
const SEND_ATTEMPTS = 3;
const SEND_RETRY_MS = 500;

// How long after a turn ends this window looks for the one its conversation's queue starts behind it: the daemon starts
// it once the ended turn's record is written, a moment after the stream closes.
const FOLLOW_ATTEMPTS = 3;
const FOLLOW_MS = 400;

// A nudge (e.g. "Continue") behind a waiting nudge with no files says nothing new, so it is not sent at all. Never
// collapses against real words or files.
const repeatsNudge = (message: { readonly text: string; readonly attachments: readonly unknown[] }, waiting?: QueuedMessage): boolean => {
    if (waiting === undefined || message.attachments.length > 0 || (waiting.attachments?.length ?? 0) > 0) {
        return false;
    }
    return isNudgeText(message.text) && isNudgeText(waiting.text);
};

// What a press re-runs a held turn on: the runtime and model the composer holds, the account only as intent (the same
// rule a send names it by, accountIntent). An empty pick means the daemon keeps the held model. `carry` keeps the
// provider session across an account change, only when asked; moving to another account is switchAccount's (continueOn).
const heldRouting = (settings: TurnSettings, session: SessionRef | undefined, options: { readonly carry?: boolean }): ResumeRouting => {
    const account = accountIntent(settings, { registered: true, resume: resumes(session, settings) ? session : undefined });
    return {
        agent: settings.agent,
        harness: settings.harness,
        ...(account === undefined ? {} : { account }),
        model: settings.model || undefined,
        ...(options.carry === true ? { carry: true } : {}),
    };
};

// A file that went out with a message the daemon never answered for, staged again in the composer as a finished chip.
const chipOf = (file: ChatAttachment): PendingAttachment => ({ id: uuid(), name: file.name, path: file.path, status: `done`, progress: 100 });

// What a waiting message's change was refused for, in the words the red line uses.
const queueRefusal = (refusal: SandboxHttpError): string => {
    if (refusal.status === 412) {
        return `That waiting message was changed in another window since you saw it: look again before changing it.`;
    }
    return refusal.status === 404 ? `That message is no longer waiting: it has gone out, or somebody took it back.` : refusal.message;
};

// What a run reads and writes of the conversation around it.
type TurnHost = Pick<
    Conversation,
    | "conversationId"
    | "transcript"
    | "selection"
    | "failures"
    | "title"
    | "isolated"
    | "runner"
    | "box"
    | "registered"
    | "standing"
    | "pendingForkOf"
    | "error"
    | "pickUp"
    | "session"
    | "agentTerminal"
    | "agentBrowser"
    | "peek"
    | "draft"
    | "attachments"
    | "queue"
>;

/** Of two copies of the daemon's queue, the one written last: a card read late must not undo a change made here. */
export const newerQueue = (held: ConversationQueue | undefined, heard: ConversationQueue | undefined): ConversationQueue | undefined =>
    heard === undefined || (held !== undefined && held.revision > heard.revision) ? held : heard;

export class TurnClient {
    // Where this window's run stands; moved only by `advance`, and every other fact about the run is read off it.
    readonly phase = shallowRef<RunPhase>(IDLE);
    // A turn is live in this window: opened or attached, and not yet settled.
    readonly streaming = computed(() => this.phase.value.kind !== `idle`);
    // Start of the in-flight turn (ms), for the card's elapsed readout; undefined while idle.
    readonly turnStartedAt = computed(() => (this.phase.value.kind === `idle` ? undefined : this.phase.value.startedAt));
    // Posture the running turn is actually in (the agent's own mode frames); display-only, cleared at each send.
    readonly liveMode = ref<PermissionMode | undefined>();
    // Harness retrying inside the live turn; nothing has failed. Cleared once the turn produces anything or settles.
    readonly providerRetry = ref<Extract<TurnFact, { kind: `provider_retry` }> | undefined>();

    // Whether the model is actually generating, narrower than `streaming`: a parked card is streaming but not this.
    readonly generating = computed(() => this.streaming.value && !this.host.transcript.awaitingDecision.value);

    // Resolves once the daemon's detached run has settled after a Stop; else the next send could race its cleanup.
    private stopping: Promise<void> | undefined;

    // The id of the message this window's open turn carries, minted per send: what a Stop names before an ack names the
    // run, and what the daemon recognises the same send by.
    private message: string | undefined;

    // A Stop the daemon could not act on yet, the message not yet a turn there: carried out at the ack, which names it.
    private stopOnAck = false;

    // Words handed back to the composer after a send nobody answered, with the id they went out under: sent again
    // unchanged they keep it, so a daemon that took them after all answers the resend rather than delivering it twice.
    private unanswered: { readonly id: string; readonly text: string } | undefined;

    // In-flight reattach probe (see reattach), aborted by a send so the two never race the same run.
    private probe: AbortController | undefined;

    // Tool ids this turn has already drawn, so a card's first arrival can be told from its updates; cleared per turn.
    private liveTools = new Set<string>();

    constructor(private readonly host: TurnHost) {}

    // Whether this turn is drawing this tool card for the first time; records it, so an update later answers no.
    firstSight(toolId: string): boolean {
        if (this.liveTools.has(toolId)) {
            return false;
        }
        this.liveTools.add(toolId);
        return true;
    }

    // Resolves once the turn ends, with whether the daemon ever took it.
    async send(prompt: string, settings: TurnSettings, attachments: readonly ChatAttachment[] = [], editorContext?: EditorContext): Promise<boolean> {
        const text = prompt.trim();
        if (text.length === 0 && attachments.length === 0) {
            return false;
        }
        // Stop makes the local stream idle before the daemon finishes unwinding; a direct send joins that boundary too.
        if (this.stopping !== undefined) {
            await this.stopping;
        }
        if (this.streaming.value) {
            return false;
        }
        let took = false;
        await this.deliverTurn(this.openTurn(text, attachments, settings), text, attachments, settings, editorContext, (taken) => {
            took = taken;
        });
        return took;
    }

    // The composer's one send path, whatever the conversation is doing: the daemon starts a turn with the words, says them
    // into the running one where it takes words, or queues them for the next, where every window sees them. An empty send
    // lets the conversation's held queue go.
    async say(text: string, attachments: readonly ChatAttachment[] = [], editorContext?: EditorContext): Promise<void> {
        const trimmed = text.trim();
        this.host.peek.value = false;
        if (trimmed.length === 0 && attachments.length === 0) {
            await this.resume();
            return;
        }
        const queue = this.host.queue.value;
        if (repeatsNudge({ text: trimmed, attachments }, queue?.items.at(-1))) {
            // The same nudge pressed again lets a held queue go rather than saying it twice.
            if (queue?.paused !== undefined) {
                await this.resume();
            }
            return;
        }
        if (this.stopping !== undefined) {
            await this.stopping;
        }
        if (this.streaming.value) {
            await this.sayInto(trimmed, attachments, editorContext);
            return;
        }
        const settings = this.host.selection.turnSettings();
        await this.deliverTurn(this.openTurn(trimmed, attachments, settings), trimmed, attachments, settings, editorContext);
    }

    // An app errand whose words need a read first: the turn opens at the call, its row and the working line drawn, and
    // `compose` fills it in (undefined: no turn after all). Resolves with whether the daemon took it, not at its end.
    async startErrand(opening: string, compose: (signal: AbortSignal) => Promise<string | undefined>): Promise<boolean> {
        this.host.peek.value = false;
        if (this.stopping !== undefined) {
            await this.stopping;
        }
        // A turn already live here can't have a second opened beside it: the words go the way any message would.
        if (this.streaming.value) {
            const prompt = await compose(new AbortController().signal);
            if (prompt === undefined) {
                return false;
            }
            void this.say(prompt);
            return true;
        }
        const settings = this.host.selection.turnSettings();
        const opened = this.openTurn(opening, [], settings, true);
        const composed = compose(opened.controller.signal);
        // A read abandoned by a Stop may still fail later, and nobody is left to hear it.
        composed.catch(() => undefined);
        // A Stop ends the turn in the frame it was pressed, whether or not the read it interrupts honours the abort.
        const stopped = new Promise<undefined>((settle) =>
            opened.controller.signal.addEventListener(`abort`, () => settle(undefined), { once: true }),
        );
        let prompt: string | undefined;
        try {
            prompt = await Promise.race([composed, stopped]);
        } catch (error) {
            // A Stop or a closed tab aborted the read: nothing was sent, so nothing is reported either.
            if (!opened.controller.signal.aborted) {
                this.takeBack(opened);
                throw error;
            }
        }
        if (prompt === undefined || opened.controller.signal.aborted) {
            this.takeBack(opened);
            return false;
        }
        this.move({ kind: `composed` });
        this.host.transcript.reword(opened.bubble, prompt);
        const words = prompt;
        return new Promise<boolean>((taken) => {
            void this.deliverTurn(opened, words, [], settings, undefined, taken);
        });
    }

    // Ends a turn this window opened before any of it left: its bubble goes.
    private takeBack(opened: OpenedTurn): void {
        this.host.transcript.dropLocal(opened.bubble);
        this.endTurn();
    }

    // What a turn does before its words leave, in the order a send always did it; the bubble and the working line draw
    // here, so whatever follows may be a wait. An errand opens `composing`, its words not written yet.
    private openTurn(text: string, attachments: readonly ChatAttachment[], settings: TurnSettings, composing = false): OpenedTurn {
        // A pending reattach probe must not race this send's stream, nor must a superseded resume fire one later.
        this.probe?.abort();
        this.host.failures.cancelProbe();
        // The session is resumed only while the selection still matches what minted it; the daemon reseeds otherwise.
        const session = this.host.session.value;
        const resume = resumes(session, settings) ? session : undefined;
        if (resume === undefined) {
            this.cutSegment();
        }
        this.host.selection.apply({ kind: `sent` });
        // The user's bubble, drawn now so the send reads as sent, replaced once the daemon's row arrives, same id.
        const bubble = this.host.transcript.append({
            role: `user`,
            text,
            ...(attachments.length > 0 ? { attachments: attachments.map((file) => file.path) } : {}),
        });
        // This turn starts from the user's pick; the previous turn's live posture is history by the time this runs.
        this.liveMode.value = undefined;
        const controller = new AbortController();
        this.beginTurn({ kind: `open`, composing, controller, startedAt: Date.now() });
        return { bubble, controller, resume };
    }

    // First message of a fresh conversation names it, free; an attachment-only send is named after the files.
    private nameAfter(text: string, attachments: readonly ChatAttachment[]): void {
        if (this.host.title.value === null) {
            this.host.title.value = deriveTitle(text.length > 0 ? text : attachments.map((file) => file.name).join(`, `));
        }
    }

    // The id a message goes out under: the one it was sent with before, when these are the same words handed back unanswered.
    private messageIdFor(text: string): string {
        const earlier = this.unanswered?.text === text ? this.unanswered.id : undefined;
        this.unanswered = undefined;
        return earlier ?? uuid();
    }

    // Words the daemon never took go back where they were typed, ahead of anything typed since, under the id they went
    // out with (see `unanswered`).
    private giveBack(sent: SentMessage, messageId: string): void {
        const { draft, attachments } = this.host;
        draft.value = draft.value.trim() === `` ? sent.text : `${sent.text}\n\n${draft.value}`;
        attachments.value = [...sent.attachments.map(chipOf), ...attachments.value];
        this.unanswered = { id: messageId, text: draft.value.trim() };
    }

    // One message to the daemon, sent again under the same id while no answer comes back. A refusal is an answer; a
    // Stop or a closed tab ends the tries.
    private async post(body: ProcedureInput<`agent.run`>, signal: AbortSignal): Promise<MessageReceipt | SandboxHttpError> {
        for (let attempt = 1; ; attempt += 1) {
            try {
                return await orRefusal(sandboxRpc.agent.run(body, { signal, context: { at: this.host.box.value } }));
            } catch (error) {
                if (signal.aborted || attempt >= SEND_ATTEMPTS) {
                    throw error;
                }
                await sleep(SEND_RETRY_MS * attempt, { signal });
            }
        }
    }

    // Turned away at the door: the daemon refused the words before taking them, says why, and hands them back.
    private turnedAway(refusal: SandboxHttpError, bubble: number | undefined, sent: SentMessage, messageId: string): void {
        if (bubble !== undefined) {
            this.host.transcript.dropLocal(bubble);
        }
        this.giveBack(sent, messageId);
        this.host.error.value = `${refusal.message} Your message is back in the composer: send it again once that's sorted.`;
    }

    // Hands an opened turn's words to the daemon and follows it to its end. `taken` hears exactly once whether the daemon
    // took the words: at its ack, or as the turn ends without one. Words it said into a turn already running, or queued
    // behind one, leave this window's bubble to the daemon's own row, and this window follows that turn instead.
    private async deliverTurn(
        opened: OpenedTurn,
        text: string,
        attachments: readonly ChatAttachment[],
        settings: TurnSettings,
        editorContext: EditorContext | undefined,
        taken: (taken: boolean) => void = () => undefined,
    ): Promise<void> {
        const { bubble: userMessageId, controller, resume } = opened;
        const { host } = this;
        // A fork names its origin on its first turn; consumed on the daemon's ack, so a refused send can retry cleanly.
        const forkOf = host.pendingForkOf.value;
        this.nameAfter(text, attachments);
        // This window's own copy of the words, for a refusal to hand back.
        const sent: SentMessage = { text, attachments };
        // Everything but the run, which the daemon only names in the ack below.
        const turn: Omit<TurnContext, "run"> = { sent, provider: settings.agent, account: settings.account, harness: settings.harness };
        // Chips and @-mentions ride apart, since only a chip was chosen; mentions skip chips, already visible inline.
        const attachmentPaths = attachments.map((file) => file.path);
        const mentionedPaths = mentionPaths(text).filter((path) => !attachmentPaths.includes(path));
        const messageId = this.messageIdFor(text);
        this.message = messageId;
        let elsewhere = false;
        try {
            const receipt = await this.post(
                turnRequestBody({
                    messageId,
                    text,
                    conversationId: host.conversationId,
                    title: host.title.value,
                    isolated: host.isolated.value,
                    runner: host.runner.value,
                    box: host.box.value,
                    mode: host.selection.mode.value,
                    settings,
                    registered: host.registered.value,
                    resume,
                    forkOf,
                    attachmentPaths,
                    mentionedPaths,
                    editorContext,
                }),
                controller.signal,
            );
            if (receipt instanceof SandboxHttpError) {
                this.turnedAway(receipt, userMessageId, sent, messageId);
                return;
            }
            // The ack means the words are the daemon's, whatever this tab does next; a fork's rows are already copied.
            host.pendingForkOf.value = undefined;
            taken(true);
            // A conversation in another box is registered by its ack, since no roster frame for that box reaches here.
            if (host.box.value !== undefined) {
                host.registered.value = true;
            }
            elsewhere = receipt.delivered !== `started` || receipt.run === undefined;
            if (elsewhere) {
                host.transcript.dropLocal(userMessageId);
            } else {
                await this.follow(receipt.run, turn, userMessageId, controller);
            }
        } catch (err) {
            this.turnBroke(err, userMessageId, sent, messageId);
        } finally {
            // Heard already on the ack, so this only speaks for a turn that ended without one.
            taken(accepted(this.phase.value));
            this.endTurn();
        }
        // Another turn holds the conversation: the words went into it or wait behind it, so that turn is the one to follow.
        if (elsewhere) {
            await this.reattach();
        }
    }

    // Follows the run a send started, from the ack on: every head replaces this run's rows with the daemon's, from the
    // bubble above, keeping its id.
    private async follow(run: string | undefined, turn: Omit<TurnContext, "run">, bubble: number, controller: AbortController): Promise<void> {
        if (run === undefined) {
            return;
        }
        const { host } = this;
        this.move({ kind: `accepted`, run });
        if (this.stopOnAck) {
            this.stopRun({ run });
        }
        await followRun(
            host.conversationId,
            run,
            {
                entry: (entry, context, replay) => host.transcript.push(entry, context, replay),
                attached: (head) => {
                    host.transcript.attachRun(head, bubble);
                    return { ...turn, run: head.run };
                },
            },
            controller,
            host.box.value,
        );
    }

    // Words for the turn this window follows: the daemon says them into it where it takes words, or queues them behind
    // it; nothing is drawn here, since the daemon's own row, or the queue every window shows, is where they appear.
    private async sayInto(text: string, attachments: readonly ChatAttachment[], editorContext: EditorContext | undefined): Promise<void> {
        const { host } = this;
        const settings = host.selection.turnSettings();
        const session = host.session.value;
        const attachmentPaths = attachments.map((file) => file.path);
        const messageId = this.messageIdFor(text);
        const sent: SentMessage = { text, attachments };
        try {
            const receipt = await this.post(
                turnRequestBody({
                    messageId,
                    text,
                    conversationId: host.conversationId,
                    title: host.title.value,
                    isolated: host.isolated.value,
                    runner: host.runner.value,
                    box: host.box.value,
                    mode: host.selection.mode.value,
                    settings,
                    registered: host.registered.value,
                    resume: resumes(session, settings) ? session : undefined,
                    forkOf: undefined,
                    attachmentPaths,
                    mentionedPaths: mentionPaths(text).filter((path) => !attachmentPaths.includes(path)),
                    editorContext,
                }),
                new AbortController().signal,
            );
            if (receipt instanceof SandboxHttpError) {
                this.turnedAway(receipt, undefined, sent, messageId);
            }
        } catch (err) {
            this.giveBack(sent, messageId);
            host.error.value = `${errorMessage(err, `Chat failed.`)} Your message is back in the composer, send it again to deliver it.`;
        }
    }

    // Where a sent turn's request or stream threw. A user-initiated Stop aborts the fetch, which is expected, not an error
    // to surface; a send the daemon never answered goes back to the composer, and the continue offer is refused too.
    private turnBroke(err: unknown, bubble: number, sent: SentMessage, messageId: string): void {
        const stopped = err instanceof DOMException && err.name === `AbortError`;
        if (!accepted(this.phase.value)) {
            this.host.transcript.dropLocal(bubble);
            this.giveBack(sent, messageId);
            this.host.error.value = stopped
                ? null
                : `${errorMessage(err, `Chat failed.`)} Your message is back in the composer, send it again to deliver it.`;
            return;
        }
        if (!stopped) {
            this.host.error.value = errorMessage(err, `Chat failed.`);
        }
    }

    // Moves the run's phase; the one write to it.
    private move(event: RunEvent): void {
        this.phase.value = advance(this.phase.value, event);
    }

    // What it means for a turn to be live in this window: opened by a send (not yet accepted: nothing is delivered until
    // the daemon says so) or attached to by reattach() (a run the daemon already took), closed by endTurn.
    private beginTurn(event: Extract<RunEvent, { kind: `open` | `attached` }>): void {
        this.move(event);
        // The card's account of this agent is now older than what this window can see for itself.
        this.host.standing.value = undefined;
        this.stopOnAck = false;
        this.host.error.value = null;
        // A turn is running, so nothing stopped is left to pick up; it supersedes any scheduled continuation.
        this.host.pickUp.value = undefined;
        // A live turn supersedes the waits a failed one opened, whether the scheduler fired it or another window did.
        this.host.failures.clear();
        this.liveTools = new Set();
    }

    // Settle it: drain the typewriter, drop streaming affordances, and mirror the finished transcript. What waited behind
    // the turn goes out as the next one, which this window follows: a box whose roster is polled would say so late.
    private endTurn(): void {
        const { host } = this;
        const phase = this.phase.value;
        host.transcript.settle();
        this.move({ kind: `settled` });
        const queue = host.queue.value;
        if (phase.kind === `running` && (queue?.items.length ?? 0) > 0 && queue?.paused === undefined) {
            void this.followQueued(phase.run);
        }
        this.message = undefined;
        // An in-turn retry belongs to the turn that was retrying; whatever it settled as, the wait is over.
        this.providerRetry.value = undefined;
        host.failures.armRenewalProbe();
        // A switch made while this turn ran held its divider back; the turn's over, so it goes here. No-op otherwise.
        host.selection.apply({ kind: `settled` });
        host.transcript.persist();
        // A remote conversation has no roster watch to invalidate its cached read, so the turn ending here is the signal.
        if (host.box.value !== undefined) {
            invalidateAgentTranscript(host.conversationId, host.box.value);
        }
    }

    // What "carry on" does: a held turn is re-run, adding nothing to the conversation; only a turn the daemon holds nothing
    // of (a Stop, a restart since) is continued by saying so.
    async continueTurn(options: { readonly carry?: boolean } = {}): Promise<string | undefined> {
        if (await this.resumeHeldTurn(options)) {
            return undefined;
        }
        const text = continuationFor(this.host.transcript.messages.value);
        await this.say(text);
        return text;
    }

    // Lets the conversation's held queue go, on the pick the composer holds now: what a fixed failure, a reconnected
    // account or a press on the held queue means. A turn it starts is followed here.
    async resume(): Promise<void> {
        const { host } = this;
        host.error.value = null;
        const released = await orRefusal(
            sandboxRpc.agent.queueResume(
                { conversationId: host.conversationId, routing: heldRouting(host.selection.turnSettings(), host.session.value, {}) },
                { context: { at: host.box.value } },
            ),
        );
        if (released instanceof SandboxHttpError) {
            host.error.value = released.message;
            return;
        }
        if (released.run !== undefined) {
            await this.reattach();
        }
    }

    // Takes a waiting message back before it goes out, as this window read it: refused when another window changed it
    // since, which the red line says. False when nothing changed.
    async unqueue(message: QueuedMessage): Promise<boolean> {
        const { host } = this;
        const left = await orRefusal(
            sandboxRpc.agent.queueRemove(
                { conversationId: host.conversationId, id: message.id, revision: message.revision },
                { context: { at: host.box.value } },
            ),
        );
        return this.heard(left);
    }

    // Rewords a waiting message where it stands in the queue, as this window read it; refused like a removal.
    async reword(message: QueuedMessage, text: string): Promise<boolean> {
        const { host } = this;
        const left = await orRefusal(
            sandboxRpc.agent.queueEdit(
                { conversationId: host.conversationId, id: message.id, revision: message.revision, text },
                { context: { at: host.box.value } },
            ),
        );
        return this.heard(left);
    }

    // The queue a change left, or why it was refused.
    private heard(left: ConversationQueue | SandboxHttpError): boolean {
        if (left instanceof SandboxHttpError) {
            this.host.error.value = queueRefusal(left);
            return false;
        }
        this.host.queue.value = newerQueue(this.host.queue.value, left);
        return true;
    }

    // Drop the session ref and terminal/browser handles when the next turn opens a fresh session, a new tmux session.
    // Written once since two callers cut a segment: an ordinary send, and resumeHeldTurn on a switched account.
    private cutSegment(): void {
        this.host.session.value = undefined;
        this.host.agentTerminal.value = undefined;
        this.host.agentBrowser.value = undefined;
    }

    // Re-run the held turn: what Continue means when the daemon kept it; false falls back to a plain continuation.
    // No message is appended: a press is the same request again, so the daemon resumes with a note, not a repeat.
    async resumeHeldTurn(options: { readonly carry?: boolean } = {}): Promise<boolean> {
        if (this.streaming.value || this.host.pickUp.value?.held === undefined) {
            return false;
        }
        if (this.stopping !== undefined) {
            await this.stopping;
        }
        const settings = this.host.selection.turnSettings();
        const session = this.host.session.value;
        const routing = heldRouting(settings, session, options);
        // A press that moves the conversation is also a segment cut: the fresh session belongs to the new credential,
        // unless carried across. One naming no account continues on the daemon's own, so there's nothing to cut.
        if (routing.account !== undefined && !resumes(session, settings) && options.carry !== true) {
            this.cutSegment();
        }
        this.host.selection.apply({ kind: `rerun` });
        if (!(await this.askResume(routing))) {
            return false;
        }
        await this.reattach();
        return true;
    }

    // Asks the daemon to move this conversation to `account` (switchAccount), the one way a conversation it holds changes
    // who pays. A chat it does not hold yet, another box, or a daemon too old for the route leaves the pick to ride the next
    // turn instead (accountIntent), and so does a turn running now (409): the pick stays on the selection either way.
    moveAccount(account: string): void {
        const { host } = this;
        if (!host.registered.value || host.box.value !== undefined || !supportsRoute(`agent.switchAccount`)) {
            return;
        }
        // A refusal (a turn running) or an unreachable daemon leaves the pick on the selection, where the next turn names it.
        void orRefusal(sandboxRpc.agent.switchAccount({ conversationId: host.conversationId, account }, { context: { at: host.box.value } })).catch((error: unknown) => {
            host.error.value = errorMessage(error, `The sandbox did not answer.`);
        });
    }

    // Continues a held turn on another account: one command, the daemon moving the conversation and re-running the turn
    // there (switchAccount). `carry` keeps the provider session (re-reads once, cold); fresh reseeds from the record.
    // False, having done nothing, where that command cannot answer (nothing held, another box, a daemon too old for the
    // route): the caller then takes the two steps an older daemon understood, the pick and the press naming it.
    async continueOn(account: string, carry: boolean): Promise<boolean> {
        const { host } = this;
        const held = host.registered.value && host.pickUp.value?.held !== undefined;
        if (this.streaming.value || !held || host.box.value !== undefined || !supportsRoute(`agent.switchAccount`)) {
            return false;
        }
        if (this.stopping !== undefined) {
            await this.stopping;
        }
        host.selection.apply({ kind: `accountMoved`, account });
        if (!carry) {
            this.cutSegment();
        }
        host.selection.apply({ kind: `rerun` });
        try {
            const moved = await orRefusal(
                sandboxRpc.agent.switchAccount({ conversationId: host.conversationId, account, ...(carry ? { carry } : {}) }, { context: { at: host.box.value } }),
            );
            if (moved instanceof SandboxHttpError) {
                host.error.value = moved.message;
                return true;
            }
        } catch (error) {
            // Unreachable, not refused: said on the red line, and the held turn stays for the next press.
            host.error.value = errorMessage(error, `The sandbox did not answer.`);
            return true;
        }
        await this.reattach();
        return true;
    }

    // Whether the daemon now runs the held turn, re-run by this press or already running (a 409, which following answers);
    // false when it holds nothing or is unreachable, so the caller continues instead and an offline press still works.
    private async askResume(routing: ResumeRouting): Promise<boolean> {
        try {
            await sandboxRpc.agent.resume({ conversationId: this.host.conversationId, routing }, { context: { at: this.host.box.value } });
            return true;
        } catch (error) {
            return error instanceof SandboxHttpError && error.status === 409;
        }
    }

    // Send a turn the sandbox kept after the door turned it away (a fix press, a peer's message): the press runs it as
    // it was started, routing and all. A sandbox that no longer keeps it (a restart since) gets its words as a send.
    async resendKept(kept: { readonly text: string; readonly attachments: readonly ChatAttachment[] }): Promise<void> {
        if (this.streaming.value) {
            return;
        }
        this.host.error.value = null;
        try {
            await sandboxRpc.agent.resume({ conversationId: this.host.conversationId }, { context: { at: this.host.box.value } });
        } catch {
            await this.say(kept.text, kept.attachments);
            return;
        }
        await this.reattach();
    }

    // User-initiated Stop: hard-cancel the turn daemon-side and let its stream draw the rest, the same way everywhere.
    stop(): void {
        if (!this.streaming.value) {
            return;
        }
        this.host.peek.value = false;
        this.endedByReader();
        // Nothing has left for the daemon to cancel: aborting the composing read ends the turn (startErrand).
        if (this.phase.value.kind === `composing`) {
            this.abort();
            return;
        }
        // A Stop names its turn, so one landing after that turn ended cannot cancel whatever the conversation started
        // next: by its run once the daemon named it, by the message it carries while the send is unanswered.
        const phase = this.phase.value;
        if (phase.kind === `running`) {
            this.stopRun({ run: phase.run });
            return;
        }
        if (this.message === undefined) {
            this.stopLocally();
            return;
        }
        this.stopRun({ messageId: this.message });
    }

    // Asks the daemon to cancel this turn. The request is retained as a barrier: its response means the run has released
    // the conversation lock. A run already over needs nothing here, its stream ends on its own; a message the daemon
    // has not made a turn of yet is stopped once its ack names the run.
    private stopRun(target: { readonly run: string } | { readonly messageId: string }): void {
        this.stopOnAck = false;
        const stopping = sandboxRpc.agent
            .stop({ conversationId: this.host.conversationId, ...target }, { context: { at: this.host.box.value } })
            .then(
                (answer) => {
                    if (!answer.stopped && `messageId` in target) {
                        this.stopWhenTaken();
                    }
                },
                () => this.stopLocally(),
            );
        this.stopping = stopping;
        void stopping.finally(() => {
            if (this.stopping === stopping) {
                this.stopping = undefined;
            }
        });
    }

    // The Stop for a send the daemon had not made a turn of when it was asked: its run is stopped as soon as it has one.
    private stopWhenTaken(): void {
        const phase = this.phase.value;
        if (phase.kind === `running`) {
            this.stopRun({ run: phase.run });
            return;
        }
        this.stopOnAck = phase.kind === `sending`;
    }

    // This side of a turn ending on the reader's say-so: arm the way back. Shared by Stop and by a dismissed question,
    // which ends the turn daemon-side with no request of its own here; the daemon holds its queue for both.
    endedByReader(): void {
        // Armed here, not in abort(): only a turn the daemon accepted gets a way back, else there's nothing to pick up.
        // Nothing to disarm either: a turn the user stopped is never held by the daemon.
        this.host.pickUp.value = accepted(this.phase.value) ? { reason: `stopped` } : undefined;
        this.host.transcript.persist();
    }

    // The stop the daemon never heard: this window draws the ending itself, freezes the cards, and drops the stream it
    // can no longer trust.
    private stopLocally(): void {
        this.host.transcript.cancelPendingCards();
        this.host.transcript.notice(`Stopped.`);
        this.abort();
        this.host.transcript.persist();
    }

    // Aborts this tab's attach stream; whatever streamed stays in the transcript, the run keeps running detached.
    // Called bare when the tab closes: the turn lands its work, and reopening reattaches to it.
    abort(): void {
        this.host.transcript.settle();
        this.probe?.abort();
        const phase = this.phase.value;
        if (phase.kind !== `idle`) {
            phase.controller.abort();
        }
        this.host.failures.cancelProbe();
    }

    // Looks for the turn the queue starts behind one that just ended, a few times, until it is found or a turn is live.
    private async followQueued(ended: string): Promise<void> {
        for (let attempt = 1; attempt <= FOLLOW_ATTEMPTS; attempt += 1) {
            await sleep(FOLLOW_MS * attempt);
            if (this.streaming.value || (await this.reattach(ended))) {
                return;
            }
        }
    }

    // Attach to a turn already running daemon-side (before a reload, from another window or device, or one the queue
    // started). False when nothing is live, so the caller falls back to hydration; `passed` is a run this window has
    // already seen to its end, which a head naming it stands down for.
    async reattach(passed?: string): Promise<boolean> {
        if (this.streaming.value) {
            return true;
        }
        const { host } = this;
        const controller = new AbortController();
        this.probe = controller;
        let engaged = false;
        const attached = (head: AttachHead): TurnContext | undefined => {
            // A send that started between this probe's entry check and the daemon's reply owns the stream.
            if (!engaged && (this.streaming.value || head.run === passed)) {
                return undefined;
            }
            if (!engaged) {
                engaged = true;
                // The daemon is streaming this run at us, so it's already its own record; nothing here is undelivered.
                this.beginTurn({ kind: `attached`, controller, startedAt: head.startedAt, run: head.run });
            }
            // This window may have drawn this run already; the head's rows replace what it holds, nothing draws twice.
            host.transcript.attachRun(head);
            // No `sent`: this window did not type these words, so a refusal has nothing of its own to hand back and
            // must not lift another composer's message into this one.
            return {
                run: head.run,
                provider: host.selection.provider.value,
                account: host.selection.account.value,
                harness: host.selection.harness.value,
            };
        };
        try {
            return await followRun(
                host.conversationId,
                undefined,
                { entry: (entry, context, replay) => host.transcript.push(entry, context, replay), attached },
                controller,
                host.box.value,
            );
        } finally {
            this.probe = undefined;
            if (engaged) {
                this.endTurn();
            }
        }
    }
}
