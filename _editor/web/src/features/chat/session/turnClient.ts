import { Latest, retry, sleep, within } from "@intentic/base/async";
import {
    type ConversationQueue,
    deriveTitle,
    type EditorContext,
    errandOfPrompt,
    mentionPaths,
    type MessageReceipt,
    type PermissionMode,
    type QueuedMessage,
    type ResumeRouting,
    type TurnErrand,
    type TurnFact,
    type HandoffMode,
} from "@intentic/sandbox-contract";
import { messageOr } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, ref, shallowRef } from "vue";
import { uuid } from "../../../lib/uuid";
import { orRefusal, SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { type ProcedureInput, sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import type { PendingAttachment } from "../drafts/useChatAttachments";
import { accountIntent, type SessionRef, type TurnSettings, turnRequestBody } from "../run/turnRequest";
import type { TurnBooking } from "../composer/later/sendLater";
import { holdOfQueue, perMessage, queueFromMessages, unbookedOf } from "../composer/later/bookings";
import { supportsRoute } from "../../../client/sandbox/useDaemonRoutes";
import { accountsOutdated } from "../accounts/accountsOutdated";
import { type ContinueOptions, repointedPickUp, withHandoffChosen } from "../run/pickUp";
import { type AttachHead, type FollowEnd, followRun, type SentMessage, type TurnContext } from "../run/turnStream";
import { invalidateAgentTranscript } from "../transcript/agentTranscript";
import { type ChatAttachment, continuationFor, isNudgeText } from "../transcript/transcript";
import { refusalWords } from "../transcript/notices/sandboxNotice";
import type { Conversation } from "./conversation";
import { accepted, advance, IDLE, phaseEnding, type RunEvent, type RunPhase, type TurnEnding } from "./runPhase";

// One conversation's runs, as this window drives them: a message is sent (opened, then taken at the daemon's ack),
// followed while it streams or waits on a card, and settled, stopped or abandoned; a turn this window never opened is
// attached to by its run. Where a run stands is one value (runPhase.ts). What waits for the next turn is the daemon's
// queue, the same for every window (Conversation.queue); nothing here holds words of its own.

// A turn this window has opened and not yet handed to the daemon: its drawn bubble, its abort, and the session this
// window held when it opened, which the account intent and a history-menu resume are read against.
interface OpenedTurn {
    readonly bubble: number;
    readonly controller: AbortController;
    readonly session: SessionRef | undefined;
}

// A message sent again under the same id while no answer comes back: the daemon answers a resend with what it did the
// first time, so trying again can never deliver the words twice. Bounds a network blip, not an outage.
const SEND_ATTEMPTS = 3;
const SEND_RETRY_MS = 500;

// How long after a turn ends this window looks for the one its conversation's queue starts behind it: the daemon starts
// it once the ended turn's record is written, a moment after the stream closes.
const FOLLOW_ATTEMPTS = 3;
const FOLLOW_MS = 400;

// How long a message sent after a Stop waits for the ended turn's stream to close, once the daemon has let the
// conversation go. It closes a moment after; the bound only keeps a stream that never does from swallowing the words.
const ENDING_CLOSE_MS = 5_000;

// A nudge (e.g. "Continue") behind a waiting nudge with no files says nothing new, so it is not sent at all. Never
// collapses against real words or files.
const repeatsNudge = (message: { readonly text: string; readonly attachments: readonly unknown[] }, waiting?: QueuedMessage): boolean => {
    if (waiting === undefined || message.attachments.length > 0 || (waiting.attachments?.length ?? 0) > 0) {
        return false;
    }
    return isNudgeText(message.text) && isNudgeText(waiting.text);
};

// What a press re-runs a held turn on: the runtime and model the composer holds, the account only as a pick the daemon
// has not taken or a hand pick no turn has run on yet (the same rule a send names it by, accountIntent); naming none leaves
// it to the daemon's record, which also moves the turn off an account that can no longer serve. An empty pick means the daemon keeps the held model.
// `carry` keeps the provider session across an account change, only when asked; moving to another account is
// switchAccount's (continueOn). `handoff` is how a spent allowance's held turn continues (the card's pick, handoffChoice.ts).
const heldRouting = (settings: TurnSettings, session: SessionRef | undefined, options: ContinueOptions): ResumeRouting => {
    const account = accountIntent(settings, { registered: true, session });
    return {
        agent: settings.agent,
        harness: settings.harness,
        ...(account === undefined ? {} : { account }),
        model: settings.model || undefined,
        ...(options.carry === true ? { carry: true } : {}),
        ...(options.handoff === undefined ? {} : { handoff: options.handoff }),
    };
};

// A file that went out with a message the daemon never answered for, staged again in the composer as a finished chip.
const chipOf = (file: ChatAttachment): PendingAttachment => ({ id: uuid(), name: file.name, path: file.path, status: `done`, progress: 100 });

// What a waiting message's change was refused for, in the words the error line uses.
const queueRefusal = (refusal: SandboxHttpError): string => {
    if (refusal.status === 412) {
        return t(`chat.turnClient.queueChangedElsewhere`);
    }
    return refusal.status === 404 ? t(`chat.turnClient.queueGone`) : refusal.message;
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
    | "autoLandDraft"
>;

/** Of two copies of the daemon's queue, the one written last: a card read late must not undo a change made here. */
export const newerQueue = (held: ConversationQueue | undefined, heard: ConversationQueue | undefined): ConversationQueue | undefined =>
    heard === undefined || (held !== undefined && held.revision > heard.revision) ? held : heard;

/** One status entry a runtime's extension set: its words, and who set them when the runtime said. */
export interface AgentStatusEntry {
    readonly text: string;
    readonly source?: string;
}

/** The entries after one agent_status fact: replaced or added by key, removed when it clears. */
export const withAgentStatus = (
    entries: ReadonlyMap<string, AgentStatusEntry>,
    fact: Extract<TurnFact, { kind: `agent_status` }>,
): ReadonlyMap<string, AgentStatusEntry> => {
    const next = new Map(entries);
    if (fact.text === null || fact.text.trim() === ``) {
        next.delete(fact.key);
    } else {
        next.set(fact.key, fact.source === undefined ? { text: fact.text } : { text: fact.text, source: fact.source });
    }
    return next;
};

/** A page the agent is still writing, as far as its markup has streamed (page_draft facts); live state only. */
export interface PageDraftView {
    readonly html: string;
    readonly title?: string;
}

/**
 * The drafts after one page_draft fact. A stretch starting where the held markup ends extends it; one starting earlier
 * (an attach replaying the turn's facts) rewrites from there; one starting past the end means a stretch was missed, and
 * the draft waits as it is rather than drawing a gap. `done` lets it go: the page itself has taken over.
 */
export const withPageDraft = (
    drafts: ReadonlyMap<string, PageDraftView>,
    fact: Extract<TurnFact, { kind: `page_draft` }>,
): ReadonlyMap<string, PageDraftView> => {
    const next = new Map(drafts);
    if (fact.done === true) {
        next.delete(fact.callId);
        return next;
    }
    const held = next.get(fact.callId) ?? { html: `` };
    const html = fact.at <= held.html.length ? held.html.slice(0, fact.at) + fact.text : held.html;
    const title = fact.title ?? held.title;
    next.set(fact.callId, title === undefined ? { html } : { html, title });
    return next;
};

export class TurnClient {
    // Where this window's run stands; moved only by `advance`, and every other fact about the run is read off it.
    readonly phase = shallowRef<RunPhase>(IDLE);
    // A turn is live in this window: opened or attached, and not yet settled.
    readonly streaming = computed(() => this.phase.value.kind !== `idle`);
    // Start of the in-flight turn (ms), for the card's elapsed readout; undefined while idle.
    readonly turnStartedAt = computed(() => (this.phase.value.kind === `idle` ? undefined : this.phase.value.startedAt));
    // Whether that start is the sandbox's own stamp (a run attached to) rather than this browser's (one it opened): an
    // elapsed count then runs against the sandbox's clock, `sandboxNow()`, or a clock that is off shows it as time.
    readonly turnOnSandboxClock = computed(() => this.phase.value.kind === `running` && this.phase.value.clock === `sandbox`);
    // Posture the running turn is actually in (the agent's own mode frames); display-only, cleared at each send.
    readonly liveMode = ref<PermissionMode | undefined>();
    // Harness retrying inside the live turn; nothing has failed. Cleared once the turn produces anything or settles.
    readonly providerRetry = ref<Extract<TurnFact, { kind: `provider_retry` }> | undefined>();
    // What the runtime's own extensions show while this turn runs (agent_status facts), by key, in the order first set.
    // Live state, not transcript: gone once the turn settles, whatever the last frame said.
    readonly agentStatus = shallowRef<ReadonlyMap<string, AgentStatusEntry>>(new Map());
    // Pages the agent is writing right now (page_draft facts), by the call writing each, for the column's foot to draw
    // as they stream in. Live state too: a draft goes when its page lands, and every one with the turn.
    readonly pageDrafts = shallowRef<ReadonlyMap<string, PageDraftView>>(new Map());

    // A person ended the live turn (Stop, or a card waved away) and it is unwinding: set in the press's own frame, long
    // before the stream closes, and published with the tab (TabFacts.ending) so the board's card and this chat say the
    // same thing from that frame on. Undefined for a turn nobody ended, and once the turn has settled.
    readonly ending = computed<TurnEnding | undefined>(() => phaseEnding(this.phase.value));

    // Whether the model is actually generating, narrower than `streaming`: a parked card is streaming but not this, and
    // neither is a turn somebody ended that is only unwinding.
    readonly generating = computed(
        () => this.streaming.value && this.ending.value === undefined && !this.host.transcript.awaitingDecision.value,
    );

    // Resolves once the daemon's detached run has settled after a Stop; else the next send could race its cleanup.
    private stopping: Promise<void> | undefined;

    // The id of the message this window's open turn carries, minted per send: what a Stop names before an ack names the
    // run, and what the daemon recognises the same send by.
    private message: string | undefined;

    // A Stop the daemon could not act on yet, the message not yet a turn there: carried out at the ack, which names it.
    private stopOnAck = false;

    // Whoever waits for the live turn to settle (afterEnding), told by endTurn.
    private settleWaiters: (() => void)[] = [];

    // Words handed back to the composer after a send nobody answered, with the id they went out under: sent again
    // unchanged they keep it, so a daemon that took them after all answers the resend rather than delivering it twice.
    private unanswered: { readonly id: string; readonly text: string } | undefined;

    // In-flight reattach probes (see reattach), every one aborted by a send so none races the same run. A set, not one
    // slot: two probes can be in flight at once (a hydration and a failure's re-probe), and a single slot overwritten by
    // the second, then cleared by the first one's `finally`, left a probe nothing could abort.
    private readonly probes = new Set<AbortController>();

    // The look for the turn a queue starts behind one that ended (followQueued): a newer ending supersedes it, and a
    // closed tab ends its waits rather than letting it attach a stream after the tab has gone.
    private readonly queuedFollow = new Latest();

    // Tool ids this turn has already drawn, so a card's first arrival can be told from its updates; cleared per turn.
    private liveTools = new Set<string>();

    // An account pick the daemon refused to move the conversation to, because a turn held it (one parked on a card
    // included): asked again as that turn settles (askMoveAgain), so what the daemon then does by itself (a booked
    // re-run, a wake, a kept turn sent again as it was) runs on the pick too, not only this window's presses.
    private unmoved: string | undefined;

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
        // Stop makes the turn read as over before the daemon finishes unwinding; a direct send joins that boundary too.
        if (this.unwinding) {
            await this.afterEnding();
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
            if (holdOfQueue(queue) !== undefined) {
                await this.resume();
            }
            return;
        }
        // Words typed after a Stop are the next turn's, not the ended one's: said into it, the daemon would queue them
        // behind the stop, which holds its queue.
        if (this.unwinding) {
            await this.afterEnding();
        }
        if (this.streaming.value) {
            await this.sayInto(trimmed, attachments, editorContext);
            return;
        }
        const settings = this.host.selection.turnSettings();
        await this.deliverTurn(this.openTurn(trimmed, attachments, settings), trimmed, attachments, settings, editorContext);
    }

    /**
     * A scheduled send: the words wait in the conversation's queue until the booking's moment (a time the reader chose, a
     * spent allowance's reopen, another agent's work landing), drawn there as scheduled in every window, and nothing
     * starts or reaches the provider before then. Nothing is drawn here either: no bubble, no working line, since no turn
     * opens. A chat the daemon has no record of yet is opened on the board by the booking itself, and a turn live here
     * goes on undisturbed. Only a sandbox from before either (no `agent.queueSchedule`) takes them the ordinary way.
     */
    async schedule(text: string, booking: TurnBooking, attachments: readonly ChatAttachment[] = [], editorContext?: EditorContext): Promise<void> {
        const trimmed = text.trim();
        this.host.peek.value = false;
        if (trimmed.length === 0 && attachments.length === 0) {
            return;
        }
        if (!supportsRoute(`agent.queueSchedule`) && (!this.host.registered.value || this.streaming.value || this.unwinding)) {
            await this.say(trimmed, attachments, editorContext);
            return;
        }
        if (this.unwinding) {
            await this.afterEnding();
        }
        this.nameAfter(trimmed, attachments);
        await this.sayInto(trimmed, attachments, editorContext, booking);
    }

    /**
     * Books what waits in the conversation's queue for another moment, whatever held it: what the held messages' Change
     * does, for the messages it names. Refused when nothing waits any more or the agent to wait for cannot land, which the
     * error line says. The ids go only to a sandbox that books each message on its own (bookings.ts): an older one would
     * re-time the whole queue whatever it was sent, as it always did.
     */
    async reschedule(booking: TurnBooking, ids?: readonly string[]): Promise<boolean> {
        const { host } = this;
        host.error.value = null;
        const named = ids !== undefined && perMessage(host.queue.value) ? { ids: [...ids] } : {};
        const left = await orRefusal(
            sandboxRpc.agent.queueSchedule({ conversationId: host.conversationId, ...booking, ...named }, { context: { at: host.box.value } }),
        );
        const heard = this.heard(left);
        // What it waited for had already come, so it went out as a turn: this window follows it.
        if (heard && !(left instanceof SandboxHttpError) && left.items.length === 0) {
            await this.reattach();
        }
        return heard;
    }

    // An app errand whose words need a read first: the turn opens at the call, its row and the working line drawn, and
    // `compose` fills it in (undefined: no turn after all). Resolves with whether the daemon took it, not at its end.
    async startErrand(opening: string, compose: (signal: AbortSignal) => Promise<string | undefined>): Promise<boolean> {
        this.host.peek.value = false;
        if (this.unwinding) {
            await this.afterEnding();
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
            // The contract's own recogniser names the errand these words are, so the row says so whatever it reads later.
            void this.deliverTurn(opened, words, [], settings, undefined, taken, errandOfPrompt(words));
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
        this.abortProbes();
        this.host.failures.cancelProbe();
        // Whether the turn goes on in this session is the daemon's to say (routing.ts); a new session it names on the
        // session frame is what cuts the segment here (turnFacts.ts).
        const session = this.host.session.value;
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
        return { bubble, controller, session };
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
    private post(body: ProcedureInput<`agent.run`>, signal: AbortSignal): Promise<MessageReceipt | SandboxHttpError> {
        return retry(() => orRefusal(sandboxRpc.agent.run(body, { signal, context: { at: this.host.box.value } })), {
            attempts: SEND_ATTEMPTS,
            delayMs: (attempt) => SEND_RETRY_MS * attempt,
            signal,
        });
    }

    // Turned away at the door: the daemon refused the words before taking them, says why, and hands them back.
    private turnedAway(refusal: SandboxHttpError, bubble: number | undefined, sent: SentMessage, messageId: string): void {
        if (bubble !== undefined) {
            this.host.transcript.dropLocal(bubble);
        }
        this.giveBack(sent, messageId);
        // In the reader's language where the refusal is one this build knows (a turn already running), else as said.
        this.host.error.value = t(`chat.sandboxNotice.refusedBack`, { reason: refusalWords(refusal.message) });
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
        errand: TurnErrand | undefined = undefined,
    ): Promise<void> {
        const { bubble: userMessageId, controller, session } = opened;
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
                    session,
                    forkOf,
                    attachmentPaths,
                    mentionedPaths,
                    editorContext,
                    errand,
                    conversationAutoLand: host.autoLandDraft.value,
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
                this.ranOn(settings);
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
    private async sayInto(
        text: string,
        attachments: readonly ChatAttachment[],
        editorContext: EditorContext | undefined,
        booking: TurnBooking | undefined = undefined,
    ): Promise<void> {
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
                    session,
                    forkOf: undefined,
                    attachmentPaths,
                    mentionedPaths: mentionPaths(text).filter((path) => !attachmentPaths.includes(path)),
                    editorContext,
                    booking,
                    conversationAutoLand: host.autoLandDraft.value,
                }),
                new AbortController().signal,
            );
            if (receipt instanceof SandboxHttpError) {
                this.turnedAway(receipt, undefined, sent, messageId);
            } else if (receipt.delivered === `started`) {
                // The turn it was typed into ended meanwhile, so these words opened one of their own on the settings.
                this.ranOn(settings);
                // A scheduled send the daemon started after all (what it waited for had come): this window follows it.
                if (booking !== undefined) {
                    await this.reattach();
                }
            } else if (booking !== undefined && receipt.delivered === `queued`) {
                this.booked({ id: messageId, text, attachments: attachmentPaths }, booking);
            }
        } catch (err) {
            this.giveBack(sent, messageId);
            host.error.value = `${messageOr(err, t(`chat.turnClient.chatFailed`))} ${t(`chat.turnClient.messageBack`)}`;
        }
    }

    // The scheduled words as the queue will hold them, drawn at the ack rather than on a roster frame that may come late
    // (a busy sandbox, another box whose roster is polled). The daemon's own queue, at the same revision, replaces it.
    private booked(message: { readonly id: string; readonly text: string; readonly attachments: readonly string[] }, booking: TurnBooking): void {
        const { host } = this;
        const held = host.queue.value ?? { items: [], revision: 0 };
        if (held.items.some((item) => item.id === message.id)) {
            return;
        }
        const revision = held.revision + 1;
        const item: QueuedMessage = { id: message.id, text: message.text, voice: `person`, queuedAt: Date.now(), revision };
        if (message.attachments.length > 0) {
            item.attachments = [...message.attachments];
        }
        // An instant or an agent to wait for, never both.
        const waitsFor = booking.sendAfter === undefined ? { until: booking.sendAt } : { after: booking.sendAfter };
        // A queue booked as a whole came from a sandbox older than per-message bookings: the newest booking holds all of
        // it there, as that sandbox's own queue will say.
        if (held.paused === `scheduled` && !perMessage(held)) {
            host.queue.value = { items: [...held.items, item], revision, paused: `scheduled`, ...waitsFor };
            return;
        }
        // Otherwise the message carries its own booking, and every other keeps its own.
        const hold = holdOfQueue(held);
        host.queue.value = queueFromMessages([...held.items, { ...item, ...waitsFor }], revision, hold === `scheduled` ? undefined : hold);
    }

    // Where a sent turn's request or stream threw. A user-initiated Stop aborts the fetch, which is expected, not an error
    // to surface; a send the daemon never answered goes back to the composer, and the continue offer is refused too.
    private turnBroke(err: unknown, bubble: number, sent: SentMessage, messageId: string): void {
        const stopped = err instanceof DOMException && err.name === `AbortError`;
        if (!accepted(this.phase.value)) {
            this.host.transcript.dropLocal(bubble);
            this.giveBack(sent, messageId);
            this.host.error.value = stopped ? null : `${messageOr(err, t(`chat.turnClient.chatFailed`))} ${t(`chat.turnClient.messageBack`)}`;
            return;
        }
        if (!stopped) {
            this.host.error.value = messageOr(err, t(`chat.turnClient.chatFailed`));
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
        // A Stop pressed before the daemon's ack armed nothing (endedByReader): the turn wasn't taken yet as far as this
        // window knew. If the ack came after all, the daemon holds a stopped turn, so the way back is armed now.
        if (phase.kind === `running` && phase.ending !== undefined && host.pickUp.value === undefined) {
            host.pickUp.value = { reason: `stopped` };
        }
        const waiters = this.settleWaiters;
        this.settleWaiters = [];
        for (const settled of waiters) {
            settled();
        }
        // Only what nothing holds goes: a booked message waits for its own time, a held one for a press.
        const queue = host.queue.value;
        if (phase.kind === `running` && unbookedOf(queue).length > 0 && holdOfQueue(queue) === undefined) {
            void this.followQueued(phase.run);
        }
        this.message = undefined;
        // An in-turn retry belongs to the turn that was retrying; whatever it settled as, the wait is over.
        this.providerRetry.value = undefined;
        // An extension's status lines belong to the turn that set them, and so do the pages it was still writing.
        this.agentStatus.value = new Map();
        this.pageDrafts.value = new Map();
        host.failures.armRenewalProbe();
        host.failures.settled();
        // A switch made while this turn ran held its divider back; the turn's over, so it goes here. No-op otherwise.
        host.selection.apply({ kind: `settled` });
        this.askMoveAgain();
        host.transcript.persist();
        // A remote conversation has no roster watch to invalidate its cached read, so the turn ending here is the signal.
        if (host.box.value !== undefined) {
            invalidateAgentTranscript(host.conversationId, host.box.value);
        }
    }

    // What "carry on" does: a held turn is re-run, and a turn the daemon holds nothing of (a Stop, a restart since) is
    // carried on by the daemon in its own session. Neither adds a word of the person's to the conversation.
    async continueTurn(options: ContinueOptions = {}): Promise<void> {
        if (await this.resumeHeldTurn(options)) {
            return;
        }
        await this.carryOn();
    }

    // Asks the daemon to carry the conversation on (agent.run `continues`): it re-runs a turn it holds after all, or goes
    // on in the session with a note of its own, recorded as its own line. So nothing is drawn here, and this window follows
    // the run that starts. A daemon from before the field takes the continuation words instead, as it always did, and its
    // own row draws them.
    private async carryOn(): Promise<void> {
        if (this.unwinding) {
            await this.afterEnding();
        }
        if (this.streaming.value) {
            return;
        }
        const { host } = this;
        host.error.value = null;
        host.peek.value = false;
        host.failures.cancelProbe();
        const settings = host.selection.turnSettings();
        host.selection.apply({ kind: `sent` });
        const body = turnRequestBody({
            messageId: uuid(),
            text: continuationFor(host.transcript.messages.value),
            conversationId: host.conversationId,
            title: host.title.value,
            isolated: host.isolated.value,
            runner: host.runner.value,
            box: host.box.value,
            mode: host.selection.mode.value,
            settings,
            registered: host.registered.value,
            session: host.session.value,
            forkOf: undefined,
            attachmentPaths: [],
            mentionedPaths: [],
            editorContext: undefined,
            continues: true,
        });
        try {
            const receipt = await this.post(body, new AbortController().signal);
            // A 409 is a turn already running (another window's press, the resume pass's rung): that one is followed.
            if (receipt instanceof SandboxHttpError && receipt.status !== 409) {
                host.error.value = receipt.message;
                return;
            }
            if (!(receipt instanceof SandboxHttpError) && receipt.delivered === `started`) {
                this.ranOn(settings);
            }
        } catch (error) {
            // Unreachable, not refused: said on the error line, and the strip stays for the next press.
            host.error.value = messageOr(error, t(`chat.turnClient.sandboxNoAnswer`));
            return;
        }
        await this.reattach();
    }

    // Lets the conversation's held queue go, on the pick the composer holds now: what a fixed failure, a reconnected
    // account or a press on the held queue means. A turn it starts is followed here. Named messages (a booked one's Send
    // now) go, and from a sandbox that books each message, a press naming none lets go only what the hold kept: every
    // booking stays on its time. An older sandbox is sent no ids, and lets its whole queue go, as it always did.
    async resume(ids?: readonly string[]): Promise<void> {
        const { host } = this;
        host.error.value = null;
        const settings = host.selection.turnSettings();
        const queue = host.queue.value;
        const named = perMessage(queue) ? { ids: [...(ids ?? unbookedOf(queue).map((item) => item.id))] } : {};
        const released = await orRefusal(
            sandboxRpc.agent.queueResume(
                { conversationId: host.conversationId, routing: heldRouting(settings, host.session.value, {}), ...named },
                { context: { at: host.box.value } },
            ),
        );
        if (released instanceof SandboxHttpError) {
            host.error.value = released.message;
            return;
        }
        // The queue the press left, ahead of a roster frame a busy sandbox may deliver long after the turn it started.
        host.queue.value = newerQueue(host.queue.value, released.queue);
        if (released.run !== undefined) {
            this.ranOn(settings);
            await this.reattach();
        }
    }

    // Takes a waiting message back before it goes out, as this window read it: refused when another window changed it
    // since, which the error line says. False when nothing changed.
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

    // Drop the session ref and terminal/browser handles when the next turn opens a fresh session, a new tmux session:
    // continueOn's, whose command retires the session by itself. Every other cut is the daemon's word, a session frame
    // naming a new session (turnFacts.ts).
    private cutSegment(): void {
        this.host.session.value = undefined;
        this.host.agentTerminal.value = undefined;
        this.host.agentBrowser.value = undefined;
    }

    // Re-run the held turn: what Continue means when the daemon kept it; false leaves it to carryOn.
    // No message is appended: a press is the same request again, so the daemon resumes with a note, not a repeat.
    async resumeHeldTurn(options: ContinueOptions = {}): Promise<boolean> {
        const held = this.host.pickUp.value?.held;
        if (this.streaming.value || held === undefined) {
            return false;
        }
        // The card's pick rides the press as well as the hold, so a pick whose save was still in flight is not lost.
        const handoff = options.handoff ?? held.handoff?.chosen;
        if (this.stopping !== undefined) {
            await this.stopping;
        }
        // Where it re-runs, and in which session, is the daemon's to say; a new session it names cuts the segment then.
        const settings = this.host.selection.turnSettings();
        const routing = heldRouting(settings, this.host.session.value, { ...options, ...(handoff === undefined ? {} : { handoff }) });
        this.host.selection.apply({ kind: `rerun` });
        const resumed = await this.askResume(routing);
        if (resumed === undefined) {
            return false;
        }
        // A 409 is a re-run somebody else's press already started, on its own routing, not on this one's.
        if (resumed === `ran`) {
            this.ranOn(settings);
        }
        await this.reattach();
        return true;
    }

    // Asks the daemon to move this conversation to `account` (switchAccount), the one way a conversation it holds changes
    // who pays. It only moves: without `run` a turn the daemon holds stays held, since a pick in the picker is a choice,
    // never a press. A chat it does not hold yet, or another box, leaves the pick to ride the next turn instead
    // (accountIntent), and so does a turn running now (409, a card waiting included), which is asked again once that turn
    // settles: the pick stays on the selection either way. A sandbox too old for the route is asked nothing: the picker
    // says it needs an update (accountsOutdated).
    moveAccount(account: string): void {
        const { host } = this;
        this.unmoved = undefined;
        // The card's wait follows the pick at once, off the same reading the composer's schedule uses: the press runs on
        // the pick, and the daemon re-books a held turn there too.
        host.pickUp.value = repointedPickUp(host.pickUp.value, host.selection.servingState.value);
        if (!host.registered.value || host.box.value !== undefined || accountsOutdated.value) {
            return;
        }
        // A refusal or an unreachable daemon leaves the pick on the selection, where every turn names it until one runs
        // there. A turn holding the conversation (409) is only a refusal for now: asked again once it settles.
        void orRefusal(sandboxRpc.agent.switchAccount({ conversationId: host.conversationId, account }, { context: { at: host.box.value } })).then(
            (answer) => {
                if (answer instanceof SandboxHttpError && answer.status === 409) {
                    this.unmoved = account;
                }
            },
            (error: unknown) => {
                host.error.value = messageOr(error, t(`chat.turnClient.sandboxNoAnswer`));
            },
        );
    }

    // Records how a spent allowance's held turn continues once it is sent again (agent.chooseHandoff): carry the session,
    // trim it, or summarise it. Starts nothing; the card shows the pick at once and snaps back if the daemon refuses it.
    async chooseHandoff(handoff: HandoffMode): Promise<boolean> {
        const { host } = this;
        const before = host.pickUp.value;
        if (before?.held?.handoff === undefined || !host.registered.value) {
            return false;
        }
        host.pickUp.value = withHandoffChosen(before, handoff);
        try {
            await sandboxRpc.agent.chooseHandoff({ conversationId: host.conversationId, handoff }, { context: { at: host.box.value } });
            return true;
        } catch (error) {
            // Only a pick still showing snaps back: a press or a new ending since owns the card now.
            if (host.pickUp.value?.held?.handoff?.chosen === handoff) {
                host.pickUp.value = withHandoffChosen(host.pickUp.value, before.held.handoff.chosen);
            }
            host.error.value = messageOr(error, t(`chat.handoffChoice.notSaved`));
            return false;
        }
    }

    // Continues a held turn on another account: one command, the daemon moving the conversation and re-running the turn
    // there (switchAccount with `run`). `carry` keeps the provider session (re-reads once, cold); fresh reseeds from the record.
    // `handoff`, where the held turn offers a choice, says which of the three ways it continues and wins over `carry`.
    // False, having done nothing, where no held turn is this sandbox's to move (nothing held, or another box): the caller
    // then picks the account and presses, which names it on the turn. Never offered by a sandbox too old for the command
    // (accountsOutdated), whose continue card says it needs an update instead.
    async continueOn(account: string, carry: boolean, handoff?: HandoffMode): Promise<boolean> {
        const { host } = this;
        const held = host.registered.value && host.pickUp.value?.held !== undefined;
        if (this.streaming.value || !held || host.box.value !== undefined) {
            return false;
        }
        if (this.stopping !== undefined) {
            await this.stopping;
        }
        host.selection.apply({ kind: `accountMoved`, account });
        // A trimmed copy is cut from the session, so only a summary (or a fresh move) starts the conversation over.
        const keepsSession = handoff === undefined ? carry : handoff !== `summary`;
        if (!keepsSession) {
            this.cutSegment();
        }
        host.selection.apply({ kind: `rerun` });
        try {
            const moved = await orRefusal(
                sandboxRpc.agent.switchAccount(
                    { conversationId: host.conversationId, account, run: true, ...(carry ? { carry } : {}), ...(handoff === undefined ? {} : { handoff }) },
                    { context: { at: host.box.value } },
                ),
            );
            if (moved instanceof SandboxHttpError) {
                host.error.value = moved.message;
                return true;
            }
        } catch (error) {
            // Unreachable, not refused: said on the error line, and the held turn stays for the next press.
            host.error.value = messageOr(error, t(`chat.turnClient.sandboxNoAnswer`));
            return true;
        }
        await this.reattach();
        return true;
    }

    // Whether the daemon now runs the held turn: re-run by this press (`ran`), or already running (`running`, a 409, which
    // following answers); undefined when it holds nothing or is unreachable, so the caller continues instead and an
    // offline press still works.
    private async askResume(routing: ResumeRouting | undefined): Promise<`ran` | `running` | undefined> {
        try {
            await sandboxRpc.agent.resume(
                { conversationId: this.host.conversationId, ...(routing === undefined ? {} : { routing }) },
                { context: { at: this.host.box.value } },
            );
            return `ran`;
        } catch (error) {
            return error instanceof SandboxHttpError && error.status === 409 ? `running` : undefined;
        }
    }

    // Send a turn the sandbox kept after the door turned it away (a fix press, a peer's message): the press runs it as
    // it was started, routing and all, unless the composer holds an account the daemon has not taken (a pick made since,
    // or one it refused to move to): the kept turn names its own account, which would win over the move, so the press
    // names the pick, as Continue does for a held turn. A sandbox that no longer keeps it (a restart since) gets its words
    // as a send.
    async resendKept(kept: { readonly text: string; readonly attachments: readonly ChatAttachment[] }): Promise<void> {
        if (this.streaming.value) {
            return;
        }
        const { host } = this;
        host.error.value = null;
        const settings = host.selection.turnSettings();
        const named = accountIntent(settings, { registered: true, session: host.session.value }) !== undefined;
        const resumed = await this.askResume(named ? heldRouting(settings, host.session.value, {}) : undefined);
        if (resumed === undefined) {
            await this.say(kept.text, kept.attachments);
            return;
        }
        if (resumed === `ran`) {
            this.ranOn(settings);
        }
        await this.reattach();
    }

    // A turn or press on these settings started at the daemon: a hand-picked account it went out on is honoured, so the
    // next turn follows the daemon's record again (the selection spends only the pick these settings carried). One that
    // only queued, or went into the live turn, carried it nowhere yet.
    private ranOn(settings: TurnSettings): void {
        this.host.selection.apply({ kind: `accountTaken`, account: settings.account });
    }

    // The move the daemon refused while a turn held the conversation, asked again now that the turn has settled, while
    // the pick still stands. Refused again (the queue started the next turn at once), it is asked at that turn's settle.
    private askMoveAgain(): void {
        const account = this.unmoved;
        this.unmoved = undefined;
        const { selection } = this.host;
        if (account !== undefined && selection.state.value.accountPicked && selection.account.value === account) {
            this.moveAccount(account);
        }
    }

    // User-initiated Stop: hard-cancel the turn daemon-side and let its stream draw the rest, the same way everywhere. The
    // turn reads as ended from this frame (`ending`); a second press on a turn already ending asks nothing more.
    stop(): void {
        if (!this.streaming.value || this.ending.value !== undefined) {
            return;
        }
        this.host.peek.value = false;
        this.endedByReader(`stop`);
        // A card the turn was parked on goes with it, as the daemon will record it: frozen at the press, so nothing still
        // offers an answer to a turn that is over.
        this.host.transcript.cancelPendingCards();
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

    // A Stop is still unwinding: its answer outstanding, or the turn it ended still streaming. Asked before waiting, so a
    // press with nothing to wait for opens its turn in its own frame, as it always did.
    private get unwinding(): boolean {
        return this.stopping !== undefined || this.ending.value !== undefined;
    }

    // What anything opened after a Stop waits for: the daemon letting the conversation go (the Stop's own answer), then
    // this window's stream of the ended turn closing, bounded so a stream that never closes cannot hold the words.
    private async afterEnding(): Promise<void> {
        if (this.stopping !== undefined) {
            await this.stopping;
        }
        if (this.ending.value === undefined) {
            return;
        }
        await within(new Promise<void>((settled) => this.settleWaiters.push(settled)), ENDING_CLOSE_MS, undefined);
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

    // This side of a turn ending on the reader's say-so: mark it ended and arm the way back. Shared by Stop and by a
    // dismissed question, which ends the turn daemon-side with no request of its own here; the daemon holds its queue
    // for both.
    endedByReader(by: TurnEnding): void {
        this.move({ kind: `ended`, by });
        // Armed here, not in abort(): only a turn the daemon accepted gets a way back, else there's nothing to pick up.
        // Nothing to disarm either: a turn the user stopped is never held by the daemon.
        this.host.pickUp.value = accepted(this.phase.value) ? { reason: `stopped` } : undefined;
        this.host.transcript.persist();
    }

    // The stop the daemon never heard: this window draws the ending itself, freezes the cards, and drops the stream it
    // can no longer trust.
    private stopLocally(): void {
        this.host.transcript.cancelPendingCards();
        this.host.transcript.notice(t(`chat.sandboxNotice.stopped`));
        this.abort();
        this.host.transcript.persist();
    }

    // Aborts this tab's attach stream; whatever streamed stays in the transcript, the run keeps running detached.
    // Called bare when the tab closes: the turn lands its work, and reopening reattaches to it.
    abort(): void {
        this.host.transcript.settle();
        this.abortProbes();
        this.queuedFollow.abort();
        const phase = this.phase.value;
        if (phase.kind !== `idle`) {
            phase.controller.abort();
        }
        this.host.failures.cancelProbe();
    }

    private abortProbes(): void {
        for (const probe of this.probes) {
            probe.abort();
        }
        this.probes.clear();
    }

    // Looks for the turn the queue starts behind one that just ended, a few times, until it is found or a turn is live.
    private async followQueued(ended: string): Promise<void> {
        const signal = this.queuedFollow.next();
        try {
            for (let attempt = 1; attempt <= FOLLOW_ATTEMPTS; attempt += 1) {
                await sleep(FOLLOW_MS * attempt, { signal });
                if (signal.aborted || this.streaming.value || (await this.reattach(ended))) {
                    return;
                }
            }
        } finally {
            this.queuedFollow.done(signal);
        }
    }

    // Attach to a turn already running daemon-side (before a reload, from another window or device, or one the queue
    // started). False when nothing is live, so the caller falls back to hydration; undefined when the daemon could not be
    // asked (FollowEnd), which is no answer at all. `passed` is a run this window has already seen to its end, which a
    // head naming it stands down for.
    async reattach(passed?: string): Promise<FollowEnd> {
        if (this.streaming.value) {
            return true;
        }
        const { host } = this;
        const controller = new AbortController();
        this.probes.add(controller);
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
            this.probes.delete(controller);
            if (engaged) {
                this.endTurn();
            }
        }
    }
}
