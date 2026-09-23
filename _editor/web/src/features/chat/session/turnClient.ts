import { deriveTitle, type EditorContext, mentionPaths, type PermissionMode, type ResumeRouting, type TurnFact } from "@intentic/sandbox-contract";
import { errorMessage } from "@intentic/ui/async";
import { computed, ref, type Ref, shallowRef } from "vue";
import type { AgentStanding } from "../../agents/fleet/agentStatus";
import { uuid } from "../../../lib/uuid";
import { orRefusal, SandboxHttpError } from "../../sandbox/client/sandboxHttpError";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
import type { PickUp } from "../run/pickUp";
import type { TurnFailures } from "../run/turnFailures";
import { resumes, type SessionRef, type TurnSettings, turnRequestBody } from "../run/turnRequest";
import { type AttachHead, followRun, postTurnControl, type SentMessage, type TurnContext } from "../run/turnStream";
import { invalidateAgentTranscript } from "../transcript/agentTranscript";
import { type ChatAttachment, continuationFor, isNudgeText } from "../transcript/transcript";
import type { ComposerSelection } from "./composerSelection";
import { accepted, advance, IDLE, type RunEvent, type RunPhase } from "./runPhase";
import type { TranscriptView } from "./transcriptView";

// One conversation's runs, as this window drives them: a message is sent (opened, then taken at the daemon's ack),
// followed while it streams or waits on a card, and settled, stopped or abandoned; a turn this window never opened is
// attached to by its run. Where a run stands is one value (runPhase.ts); the queue is the one thing that outlives it.

// A message sent while a turn runs, not yet delivered: steered into it if the harness takes mid-turn input,
// else sent as the next turn once it settles. Carries files and editor context like an ordinary message.
export interface QueuedMessage {
    readonly id: string;
    readonly text: string;
    readonly attachments: readonly ChatAttachment[];
    readonly editorContext?: EditorContext;
}

// A turn this window has opened and not yet handed to the daemon: its drawn bubble, its abort, the session it resumes.
interface OpenedTurn {
    readonly bubble: number;
    readonly controller: AbortController;
    readonly resume: SessionRef | undefined;
}

// Two adjacent queued nudges with no attachments (e.g. repeated "Continue") collapse into one: a second behind an
// undelivered first says nothing new. Never collapses against real words or attachments.
const repeatsNudge = (message: { readonly text: string; readonly attachments: readonly ChatAttachment[] }, neighbour?: QueuedMessage): boolean => {
    if (neighbour === undefined || message.attachments.length > 0 || neighbour.attachments.length > 0) {
        return false;
    }
    return isNudgeText(message.text) && isNudgeText(neighbour.text);
};

// Routing for re-running a held turn, read at the press; an empty pick means the daemon keeps the held model.
// `carry` keeps the provider session across an account change, only when asked.
const heldRouting = (settings: TurnSettings, options: { readonly carry?: boolean }): ResumeRouting => ({
    agent: settings.agent,
    harness: settings.harness,
    account: settings.account,
    model: settings.model || undefined,
    ...(options.carry === true ? { carry: true } : {}),
});

// What a run reads and writes of the conversation around it.
export interface TurnHost {
    readonly conversationId: string;
    readonly transcript: TranscriptView;
    readonly selection: ComposerSelection;
    readonly failures: TurnFailures;
    // Named after its first message, once, when a turn opens.
    readonly title: Ref<string | null>;
    // Where the run happens: a worktree or /work, a paired runner, another box; the body a send carries names each.
    readonly isolated: Ref<boolean>;
    readonly runner: Ref<string | undefined>;
    readonly box: Ref<string | undefined>;
    // Latched by the ack of a turn in another box, whose roster never reaches this browser.
    readonly registered: Ref<boolean>;
    // The card's account of the agent, which a turn running here makes stale.
    readonly standing: Ref<AgentStanding | undefined>;
    // Where a fork was cut from, carried by its first turn and spent at the ack.
    readonly pendingForkOf: Ref<{ conversationId: string; keep: number; files: "then" | "now" } | undefined>;
    // The red line, and the offer to carry on a turn that stopped short.
    readonly error: Ref<string | null>;
    readonly pickUp: Ref<PickUp | undefined>;
    // The session a matching turn resumes, and the tmux and browser handles minted under it.
    readonly session: Ref<SessionRef | undefined>;
    readonly agentTerminal: Ref<string | undefined>;
    readonly agentBrowser: Ref<string | undefined>;
    // A send is the reader acting on this chat, which takes it out of the peek slot.
    readonly peek: Ref<boolean>;
}

export class TurnClient {
    // Where this window's run stands; moved only by `advance`, and every other fact about the run is read off it.
    readonly phase = shallowRef<RunPhase>(IDLE);
    // A turn is live in this window: opened or attached, and not yet settled.
    readonly streaming = computed(() => this.phase.value.kind !== `idle`);
    // Start of the in-flight turn (ms), for the card's elapsed readout; undefined while idle.
    readonly turnStartedAt = computed(() => (this.phase.value.kind === `idle` ? undefined : this.phase.value.startedAt));
    // Messages submitted while a turn ran, not yet delivered; see enqueue/drainQueue. Rendered above the composer.
    readonly queued = ref<QueuedMessage[]>([]);
    // Posture the running turn is actually in (the agent's own mode frames); display-only, cleared at each send.
    readonly liveMode = ref<PermissionMode | undefined>();
    // Harness retrying inside the live turn; nothing has failed. Cleared once the turn produces anything or settles.
    readonly providerRetry = ref<Extract<TurnFact, { kind: `provider_retry` }> | undefined>();

    // Whether the model is actually generating, narrower than `streaming`: a parked card is streaming but not this.
    readonly generating = computed(() => this.streaming.value && !this.host.transcript.awaitingDecision.value);

    // Resolves once the daemon's detached run has settled after a Stop; else the next send could race its cleanup.
    private stopping: Promise<void> | undefined;

    // In-flight reattach probe (see reattach), aborted by a send so the two never race the same run.
    private probe: AbortController | undefined;

    // Set by abort/Stop/tab close/sandbox switch; an interrupted turn must not flush the queue on its own.
    private interrupted = false;

    // True while drainQueue owns the idle flush, so a second drain can't send the same messages twice.
    private flushing = false;

    // Queued messages handed to a send the daemon has not acknowledged; they are still in `queued`, so nothing about
    // them is lost if this window dies, and a refusal has nothing to hand back (requeueUndelivered).
    private undelivered: readonly QueuedMessage[] = [];

    // Whether this turn's message has already gone back to the queue; cleared per turn by beginTurn.
    private requeued = false;

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

    // An app errand whose words need a read first: the turn opens at the call, its row and the working line drawn, and
    // `compose` fills it in (undefined: no turn after all). Resolves with whether the daemon took it, not at its end.
    async startErrand(opening: string, compose: (signal: AbortSignal) => Promise<string | undefined>): Promise<boolean> {
        // The user is driving again, exactly as a composer send says it (see `enqueue`).
        this.interrupted = false;
        this.host.peek.value = false;
        if (this.stopping !== undefined) {
            await this.stopping;
        }
        // A turn already live here can't have a second opened beside it: the words go the way any message would.
        if (this.streaming.value || this.flushing) {
            const prompt = await compose(new AbortController().signal);
            if (prompt === undefined) {
                return false;
            }
            void this.enqueue(prompt);
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

    // Ends a turn this window opened before any of it left: its bubble goes, and the queue behind it may flush.
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

    // Turned away at the door, the words back in the queue; true for a 409, a turn this window isn't following (the resume
    // pass's re-run, another window), which the caller follows once this one ends so the words ride its end.
    private turnedAway(refusal: SandboxHttpError, bubble: number, sent: SentMessage): boolean {
        this.host.transcript.dropLocal(bubble);
        this.requeueUndelivered(sent);
        if (refusal.status === 409) {
            return true;
        }
        this.host.error.value = `${refusal.message} Your message is held below: send it again once that's sorted.`;
        return false;
    }

    // Follows the turn a 409 said is running; with none left to follow by the time this asks, the words stay held.
    private async followBusy(): Promise<void> {
        if (!(await this.reattach())) {
            this.host.error.value = `This agent already has a turn running: your message is held below, send it again once it finishes.`;
        }
    }

    // Hands an opened turn's words to the daemon and follows it to its end. `taken` hears exactly once whether the daemon
    // took the turn: at its ack, or as the turn ends without one.
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
        // This window's own copy of the words, for a refusal to hand back; the daemon retracts its row itself.
        const sent: SentMessage = { text, attachments };
        // Everything but the run, which the daemon only names in the ack below.
        const turn: Omit<TurnContext, "run"> = { sent, provider: settings.agent, account: settings.account, harness: settings.harness };
        // Chips and @-mentions ride apart, since only a chip was chosen; mentions skip chips, already visible inline.
        const attachmentPaths = attachments.map((file) => file.path);
        const mentionedPaths = mentionPaths(text).filter((path) => !attachmentPaths.includes(path));
        let busy = false;
        try {
            const started = await orRefusal(
                sandboxRpc.agent.run(
                    turnRequestBody({
                        text,
                        conversationId: host.conversationId,
                        title: host.title.value,
                        isolated: host.isolated.value,
                        runner: host.runner.value,
                        box: host.box.value,
                        mode: host.selection.mode.value,
                        settings,
                        resume,
                        forkOf,
                        attachmentPaths,
                        mentionedPaths,
                        editorContext,
                    }),
                    { signal: controller.signal, context: { at: host.box.value } },
                ),
            );
            if (started instanceof SandboxHttpError) {
                busy = this.turnedAway(started, userMessageId, sent);
                return;
            }
            // The ack means the turn is running daemon-side regardless of this tab; a fork's rows are already copied.
            host.pendingForkOf.value = undefined;
            // The daemon has the words now, so the queue's copy of them stops being the only one that exists.
            this.settleDelivered();
            this.move({ kind: `accepted` });
            taken(true);
            // A conversation in another box is registered by its ack, since no roster frame for that box reaches here.
            if (host.box.value !== undefined) {
                host.registered.value = true;
            }
            await followRun(
                host.conversationId,
                started.run,
                {
                    entry: (entry, context, replay) => host.transcript.push(entry, context, replay),
                    // Every head replaces this run's rows with the daemon's, from the bubble above, keeping its id.
                    attached: (head) => {
                        host.transcript.attachRun(head, userMessageId);
                        return { ...turn, run: head.run };
                    },
                },
                controller,
                host.box.value,
            );
        } catch (err) {
            this.turnBroke(err, userMessageId, sent);
        } finally {
            // Heard already on the ack, so this only speaks for a turn that ended without one.
            taken(accepted(this.phase.value));
            this.endTurn();
            if (busy) {
                void this.followBusy();
            }
        }
    }

    // Where a sent turn's request or stream threw. A user-initiated Stop aborts the fetch, which is expected, not an error
    // to surface; a send that never left gets its bubble back into the queue, and the continue offer is refused too.
    private turnBroke(err: unknown, bubble: number, sent: SentMessage): void {
        const stopped = err instanceof DOMException && err.name === `AbortError`;
        if (!accepted(this.phase.value)) {
            this.host.transcript.dropLocal(bubble);
            this.requeueUndelivered(sent);
            this.host.error.value = stopped ? null : `${errorMessage(err, `Chat failed.`)} Your message is held below, send it again to deliver it.`;
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
        // This turn has not handed its message back yet; the latch is per turn, not per conversation.
        this.requeued = false;
        // Whatever interrupted the last turn is history, so this one's clean end may flush the queue.
        this.interrupted = false;
        this.host.error.value = null;
        // A turn is running, so nothing stopped is left to pick up; it supersedes any scheduled continuation.
        this.host.pickUp.value = undefined;
        // A live turn supersedes the waits a failed one opened, whether the scheduler fired it or another window did.
        this.host.failures.clear();
        this.liveTools = new Set();
    }

    // Settle it: drain the typewriter, drop streaming affordances, mirror the finished transcript, and let anything
    // queued behind the turn go.
    private endTurn(): void {
        const { host } = this;
        host.transcript.settle();
        this.move({ kind: `settled` });
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
        void this.drainQueue();
    }

    // The composer's one send path: the message is accepted whatever the conversation is doing.
    // - idle: starts a turn immediately, with anything already queued;
    // - turn running: handed to it where the harness takes mid-turn input, else waits and goes as the next turn.
    // An empty message with a non-empty queue just drains the queue.
    enqueue(text: string, attachments: readonly ChatAttachment[] = [], editorContext?: EditorContext): Promise<void> {
        const trimmed = text.trim();
        // The user is driving again: a Stop's hold on the queue is released (see `interrupted`).
        this.interrupted = false;
        this.host.peek.value = false;
        if ((trimmed.length > 0 || attachments.length > 0) && !repeatsNudge({ text: trimmed, attachments }, this.queued.value.at(-1))) {
            this.queued.value = [
                ...this.queued.value,
                { id: uuid(), text: trimmed, attachments, ...(editorContext !== undefined ? { editorContext } : {}) },
            ];
        }
        return this.drainQueue();
    }

    // What "carry on" does: a held turn is re-run, adding nothing to the conversation; only a turn the daemon holds nothing
    // of (a Stop, a restart since) is continued by saying so.
    async continueTurn(options: { readonly carry?: boolean } = {}): Promise<string | undefined> {
        if (await this.resumeHeldTurn(options)) {
            return undefined;
        }
        const text = continuationFor(this.host.transcript.messages.value);
        await this.enqueue(text);
        return text;
    }

    // Drop a queued message before it reaches the agent (the × on its chip).
    removeQueued(id: string): void {
        this.queued.value = this.queued.value.filter((message) => message.id !== id);
    }

    // Drops the messages a turn was started from, now that the daemon holds them; called at the ack alone, so anything
    // refused before it stays queued.
    private settleDelivered(): void {
        if (this.undelivered.length === 0) {
            return;
        }
        const delivered = this.undelivered;
        this.undelivered = [];
        this.queued.value = this.queued.value.filter((message) => !delivered.includes(message));
    }

    // Queues a turned-away message at the front again. Held, not flushed: a refusal that ran nothing would re-fail,
    // and the words come from this window's own send, since the daemon has already retracted its row.
    requeueUndelivered(sent: SentMessage | undefined): void {
        this.interrupted = true;
        // Refused before the ack: the words never left the queue, so they are already where a resend reads them.
        if (sent === undefined || this.undelivered.length > 0) {
            return;
        }
        // Latched per turn: a fact replays on every attach, so one refusal would queue the message once per reconnect.
        if (this.requeued) {
            return;
        }
        this.requeued = true;
        // Pressed again while this turn was already failing, so the words are the same nudge already queued.
        if (repeatsNudge(sent, this.queued.value[0])) {
            return;
        }
        this.queued.value = [{ id: uuid(), text: sent.text, attachments: sent.attachments }, ...this.queued.value];
    }

    // Holds the queue in place: a message behind a killed turn must not race the daemon's resume to a send and lose.
    hold(): void {
        this.interrupted = true;
    }

    // Drop the session ref and terminal/browser handles when the next turn opens a fresh session, a new tmux session.
    // Written once since two callers cut a segment: an ordinary send, and resumeHeldTurn on a switched account.
    private cutSegment(): void {
        this.host.session.value = undefined;
        this.host.agentTerminal.value = undefined;
        this.host.agentBrowser.value = undefined;
    }

    // Release a hold placed by a now-fixed failure and let whatever was held ride immediately; a no-op when the queue
    // is empty.
    resume(): Promise<void> {
        this.interrupted = false;
        this.host.error.value = null;
        return this.drainQueue();
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
        // This switch is also a segment cut: the fresh session belongs to the new credential, unless carried across.
        if (!resumes(this.host.session.value, settings) && options.carry !== true) {
            this.cutSegment();
        }
        this.host.selection.apply({ kind: `rerun` });
        if (!(await this.askResume(heldRouting(settings, options)))) {
            return false;
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
            await this.enqueue(kept.text, kept.attachments);
            return;
        }
        await this.reattach();
    }

    // Deliver what's waiting, oldest first: a running turn takes them over `agent.steer`, a parked card skips them.
    // With nothing running, the whole queue rides one fresh turn. Public so card replies can re-drive it.
    async drainQueue(): Promise<void> {
        // A message queued right after Stop must not be steered into the aborting turn nor started before it settles.
        if (this.stopping !== undefined) {
            await this.stopping;
        }
        for (;;) {
            const next = this.queued.value[0];
            if (next === undefined) {
                return;
            }
            if (this.streaming.value) {
                if (this.host.transcript.awaitingDecision.value || !(await this.deliverSteer(next))) {
                    return;
                }
                continue;
            }
            // An interrupted turn doesn't flush; same for a flush already in flight, which owns these messages.
            if (this.interrupted || this.flushing) {
                return;
            }
            // A refused batch stays queued for whatever refused it to release: resent here, it is refused again per round trip.
            if (!(await this.flush(this.queued.value))) {
                return;
            }
        }
    }

    // The whole queue as one fresh turn, owning the idle flush until it ends; resolves with whether the daemon took it.
    private async flush(pending: QueuedMessage[]): Promise<boolean> {
        this.flushing = true;
        // The words stay in the queue until the daemon has the turn (settleDelivered, at the ack): the queue rides the
        // tab snapshot, so a window that dies mid-send — a dev-server reload, a closed tab — leaves them on the tab to
        // send again rather than nowhere, with no turn anywhere either.
        this.undelivered = pending;
        try {
            return await this.send(
                pending
                    .map((message) => message.text)
                    .filter((text) => text.length > 0)
                    .join(`\n\n`),
                this.host.selection.turnSettings(),
                pending.flatMap((message) => [...message.attachments]),
                pending.find((message) => message.editorContext !== undefined)?.editorContext,
            );
        } finally {
            this.undelivered = [];
            this.flushing = false;
        }
    }

    // Hand one queued message to the running turn via steer; false when no steerable turn is live, so it stays queued.
    // The transcript write isn't done here: the daemon's `steer` frame draws the bubble everywhere.
    private async deliverSteer(message: QueuedMessage): Promise<boolean> {
        const paths = message.attachments.map((file) => file.path);
        const mentioned = mentionPaths(message.text).filter((path) => !paths.includes(path));
        const delivered = await postTurnControl(this.host.box.value, `steer`, {
            conversationId: this.host.conversationId,
            text: message.text,
            ...(paths.length > 0 ? { attachments: paths } : {}),
            ...(mentioned.length > 0 ? { mentions: mentioned } : {}),
            ...(message.editorContext !== undefined ? { editorContext: message.editorContext } : {}),
        });
        if (!delivered) {
            return false;
        }
        this.removeQueued(message.id);
        return true;
    }

    // User-initiated Stop: hard-cancel the turn daemon-side and let its stream draw the rest, the same way everywhere.
    // The request is retained as a barrier: its response means the run has released the conversation lock.
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
        const stopping = postTurnControl(this.host.box.value, `stop`, { conversationId: this.host.conversationId }).then((delivered) => {
            if (!delivered) {
                this.stopLocally();
            }
        });
        this.stopping = stopping;
        void stopping.finally(() => {
            if (this.stopping === stopping) {
                this.stopping = undefined;
            }
        });
    }

    // This side of a turn ending on the reader's say-so: hold the queue and arm the way back. Shared by Stop and by a
    // dismissed question, which ends the turn daemon-side with no request of its own here.
    endedByReader(): void {
        // Hold the queue back from the settle flush: a stopped agent must not restart. Nothing to disarm here — a turn
        // the user stopped is never held by the daemon, so no policy of this conversation's has anything to act on.
        this.interrupted = true;
        // Armed here, not in abort(): only a turn the daemon accepted gets a way back, else there's nothing to pick up.
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
        // Ending on someone's say-so, not its own: hold the queue. Whatever the daemon has booked keeps its own clock;
        // closing a tab was never a reason to cancel work the conversation was told to carry on with.
        this.interrupted = true;
        this.host.transcript.settle();
        this.probe?.abort();
        const phase = this.phase.value;
        if (phase.kind !== `idle`) {
            phase.controller.abort();
        }
        this.host.failures.cancelProbe();
    }

    // Attach to a turn already running daemon-side (before a reload, or from another window/device). False when nothing
    // is live, so the caller falls back to hydration.
    async reattach(): Promise<boolean> {
        if (this.streaming.value) {
            return true;
        }
        const { host } = this;
        const controller = new AbortController();
        this.probe = controller;
        let engaged = false;
        const attached = (head: AttachHead): TurnContext | undefined => {
            // A send that started between this probe's entry check and the daemon's reply owns the stream.
            if (!engaged && this.streaming.value) {
                return undefined;
            }
            if (!engaged) {
                engaged = true;
                // The daemon is streaming this run at us, so it's already its own record; nothing here is undelivered.
                this.beginTurn({ kind: `attached`, controller, startedAt: head.startedAt });
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
