import type { EditorContext } from "@intentic/sandbox-contract";
import type { IconName, TooltipValue } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { formatClock, formatDayMonthTime, formatWeekdayTime } from "@intentic/ui/format";
import { t as translate, useT } from "@intentic/ui/i18n";
import { computed, nextTick, type Ref } from "vue";
import {
    type ComposerSituation,
    type ComposerWords,
    continueOffered,
    continueVisible,
    placeholderFor,
    reopenHintFor,
    reopenPressOf,
    type ReopenPress,
    sendable,
    sendHintFor,
    sendIntentOf,
    type SendIntent,
    sendRefusal,
    sendRefusalTitle,
    unconnectedHint,
    unconnectedPlaceholder,
    viewerPlaceholder,
} from "../../composer/composerIntent";
import type { InputHistory } from "../../drafts/inputHistory";
import { continueKeyHintOf } from "./continueKeyHint";
import { bookingOf, laterLabel, type SendLater, type TurnBooking } from "../../composer/later/sendLater";
import type { RunThrough } from "../../models/run-settings/useRunThrough";
import type { ChatRouting } from "../../routing/chatRoute";
import { type ContinueOptions, type PickUp, pickUpReady, pickUpShort, wakesHeldUntil } from "../../run/endings/pickUp";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";
import { formatReset } from "../../session/usageStatus";
import { planFeedback } from "../../session/cardReplies";
import { track } from "../../../../app/analytics";
import { invalidateAgentTranscript } from "../../transcript/agentTranscript";
import { type ChatAttachment, type ChatMessage, continuationFor } from "../../transcript/transcript";
import type { ConversationView } from "../useChat-view";

// What one pane's Send means and does. The meaning is composerIntent.ts's ladder read against this composer's state
// (what it says, whether it may, what Stop and the queue will do); the doing is the press itself, in the precedence
// the intents are named in: speak as the agent, spend an armed edit, a run-through badge, Continue, then a message.

export interface SendHost {
    readonly view: ConversationView;
    // The Agent pill: armed, the next press places the words as the agent's (no turn) and disarms itself.
    readonly voiceAgent: Ref<boolean>;
    // The staged chips as a message carries them.
    readonly staging: { readonly snapshot: () => ChatAttachment[] };
    // The chip offering the file in view: whether this send carries it, and what it carries.
    readonly editorContext: { readonly include: Ref<boolean>; readonly forSend: () => EditorContext | undefined };
    readonly runThrough: Pick<RunThrough, "clearFailures" | "claimSend">;
    readonly route: Pick<ChatRouting, "beforeSend">;
    // The sandbox's recall ring every sent sentence joins.
    readonly history: Readonly<Ref<InputHistory | undefined>>;
    readonly reachable: Readonly<Ref<boolean>>;
    // A viewer's composer is present but inert.
    readonly canDrive: Readonly<Ref<boolean>>;
    readonly mobile: Readonly<Ref<boolean>>;
    readonly words: Readonly<Ref<ComposerWords>>;
    // Re-arms following the transcript's newest row.
    readonly pin: () => void;
    // Re-measures the emptied box and puts the caret back in it, once the DOM has caught up.
    readonly refocus: () => void;
    // What a press with nothing to send with does instead: opens the model list.
    readonly openModels: () => void;
    // Sets this conversation's limit answer to resend, unless something already arms it: what sends a scheduled message
    // again when the reopen it was booked for came too early and was refused. Runs beside the send, never ahead of it (a
    // chat's first message is what registers it), which is safe because the daemon asks the answer afresh at the refusal.
    readonly armLimitResend: () => Promise<void>;
    // Whether that answer already sends a held turn again by itself: then a bare press on a spent account has nothing
    // left to set, and its button says the turn goes by itself instead.
    readonly limitArmed: Readonly<Ref<boolean>>;
    // Whether this composer may book a message for a time or another agent's land (the send's own caret, ChatPane).
    readonly laterOffered: Readonly<Ref<boolean>>;
    // The title an agent's card goes by, for a message booked to wait for it.
    readonly titleOf: (conversationId: string) => string | undefined;
}

// The turn as the composer treats it: a turn a person already ended is over here from the press, whatever is still
// unwinding behind it, so what is typed next is the next turn's (TurnClient.say waits the unwind out), never words for
// the ended one or an answer to a card it took with it.
const composerTurn = ({ streaming, ending, awaitingDecision, pendingPlanMessage }: ConversationView) => ({
    live: computed(() => streaming.value && ending.value === undefined),
    parked: computed(() => awaitingDecision.value && ending.value === undefined),
    planMessage: computed(() => (ending.value === undefined ? pendingPlanMessage.value : undefined)),
});

// The plan's Approve, from the bar pinned above the box (ChatWaitingBar). With notes in the box it is "approve with these
// notes": the plan reply carries no words beside a yes (its feedback is a rejection's), so the approval goes first and
// the notes follow as an ordinary message, which the running turn takes mid-turn or right after. The box empties at the
// press and gets its words back if the approval did not land. And its "keep planning": the box's notes when it holds
// any (what Send does here), else a bare no. These two are the plan's only answers; its card in the transcript has none.
const planAnswers = (
    host: SendHost,
    planMessage: Readonly<Ref<ChatMessage | undefined>>,
    composer: { readonly settle: () => void; readonly sendDraft: () => void },
) => {
    const { view, history, editorContext } = host;
    const { draft, attachments, staged } = view;
    const approvePlan = async (): Promise<void> => {
        const plan = planMessage.value?.plan;
        if (plan === undefined || !host.reachable.value) {
            return;
        }
        const text = draft.value.trim();
        const staging = attachments.value;
        const files = host.staging.snapshot();
        const context = editorContext.forSend();
        const notes = text.length > 0 || files.length > 0;
        if (notes) {
            attachments.value = [];
            editorContext.include.value = false;
            composer.settle();
        }
        const approved = await view.conversation.value.requests.reply(plan.requestId, { kind: `plan`, approve: true });
        if (!notes) {
            return;
        }
        if (!approved) {
            draft.value = text;
            attachments.value = staging;
            return;
        }
        void view.send(text, files, context);
        if (text.length > 0) {
            history.value?.record(text);
        }
        host.pin();
    };
    const keepPlanning = (): void => {
        const plan = planMessage.value?.plan;
        if (plan === undefined || !host.reachable.value) {
            return;
        }
        if (staged.value) {
            composer.sendDraft();
            return;
        }
        void view.conversation.value.requests.reply(plan.requestId, { kind: `plan`, approve: false });
    };
    return { approvePlan, keepPlanning };
};

// When the reader picked for the next message to go, where this composer may book one (sendLater.ts).
const laterPick = (host: Pick<SendHost, "view" | "laterOffered">) =>
    computed(() => (host.laterOffered.value ? host.view.conversation.value.sendLater.value : undefined));

// A booked instant as the send says it: the clock on its own day, the weekday beside it within the week, else the date.
const WEEK = 7 * 24 * 60 * 60 * 1_000;
const bookedClock = (at: number, now: number): string => {
    if (new Date(at).toDateString() === new Date(now).toDateString()) {
        return formatClock(at);
    }
    return at - now < WEEK ? formatWeekdayTime(at) : formatDayMonthTime(at);
};

// The scheduled press as the row draws it: a time-labelled button for a spent account's reopen or a booked message.
const scheduledPress = (press: {
    readonly intent: Readonly<Ref<SendIntent>>;
    readonly later: Readonly<Ref<SendLater | undefined>>;
    readonly spentUntil: Readonly<Ref<number | undefined>>;
    readonly now: Readonly<Ref<number>>;
    readonly words: Readonly<Ref<ComposerWords>>;
    readonly titleOf: (conversationId: string) => string | undefined;
}) => {
    const booked = computed(() => (press.intent.value === `later` ? press.later.value : undefined));
    return {
        // The button's label: when it goes, in the few characters the send has, or the agent whose land it waits for.
        // A booked time reads as the clock it was picked as ("21:00", "Tue 09:00"), the hour the menu marks; a spent
        // allowance's reopen counts down while it is near ("40m"), since nobody picked it. The send says it alone: no
        // pill beside it repeats it. Undefined for every other press.
        scheduledLabel: computed(() => {
            const picked = booked.value;
            if (picked !== undefined) {
                return picked.kind === `at`
                    ? bookedClock(picked.at, press.now.value)
                    : (press.titleOf(picked.conversationId) ?? translate(`chat.sendLater.anotherAgent`));
            }
            const until = press.spentUntil.value;
            return press.intent.value === `scheduled` && until !== undefined ? pickUpShort(until, press.now.value) : undefined;
        }),
        // What the press waits for, as its glyph: a clock for a time, a link for another agent's land.
        scheduledIcon: computed<IconName>(() => (booked.value?.kind === `after` ? `link` : `clock`)),
        // The whole sentence for the press's accessible name: when it goes.
        scheduledWhen: computed(() => press.words.value.later ?? press.words.value.reopens),
    };
};

// How a stopped turn goes on once the spent account reopens, when it may: a held limit turn by its own appointment (the
// limit answer, which the press sets or finds set), anything else by a continuation booked for the reopen, which only a
// sandbox that books can hold. A flagged turn has neither: only its own card re-runs it, without the stopped response,
// and a booked word would send it again with that response still in the session.
const atReopenOf = (pick: PickUp | undefined, limitArmed: boolean): ReopenPress | `armed` | undefined => {
    if (pick === undefined || pick.reason === `flagged`) {
        return undefined;
    }
    if (pick.reason === `limit` && pick.held !== undefined) {
        return limitArmed ? `armed` : `arm`;
    }
    return supportsRoute(`agent.queueSchedule`) ? `book` : undefined;
};

// What a bare press does with a stopped turn: continue it now (an account with room, or a caller that just made room
// itself, ahead of a spent reading the usage feed has not caught up with), continue it at the reopen, or neither.
const barePressOf = (offered: boolean, press: ReopenPress | undefined, madeRoom: boolean): `now` | `reopen` | undefined => {
    if (offered || (press !== undefined && madeRoom)) {
        return `now`;
    }
    return press === undefined ? undefined : `reopen`;
};

// Continuing at the reopen, which is what the strip's "Continue at 02:00" and the time-labelled button both say: a held
// limit turn's answer is set to send it again then; any other turn gets its continuation booked for then, which waits in
// the queue drawn as scheduled (its own Change and Send now) and sends nothing before. The answer is set for a booking
// too, as for any scheduled send: a reopen the provider named too early refuses it, and it goes at the next. A failed
// write leaves the card's own control saying `wait`.
const reopenContinuation =
    (
        host: Pick<SendHost, "view" | "reachable" | "armLimitResend" | "pin">,
        spentUntil: Readonly<Ref<number | undefined>>,
        press: Readonly<Ref<ReopenPress | undefined>>,
    ) =>
    (): void => {
        const until = spentUntil.value;
        const way = press.value;
        if (!host.reachable.value || until === undefined || way === undefined) {
            return;
        }
        // allow(silent-catch): the write is optimistic and rolls back on failure, so the card's control saying `wait` is the report.
        void host.armLimitResend().catch(() => undefined);
        if (way === `book`) {
            const chat = host.view.conversation.value;
            track(`message_sent`, { agent: chat.selection.provider.value, scheduled: true });
            void chat.turn.schedule(continuationFor(host.view.messages.value), { sendAt: until });
        }
        host.pin();
    };

// The readings a stopped turn on a spent account adds to the ladder's, each one computed off the same snapshot.
const reopenReadings = (on: {
    readonly situation: Readonly<Ref<ComposerSituation>>;
    readonly intent: Readonly<Ref<SendIntent>>;
    readonly continueOffer: Readonly<Ref<boolean>>;
    readonly spentUntil: Readonly<Ref<number | undefined>>;
    readonly now: Readonly<Ref<number>>;
}) => {
    // How the strip's turn goes on at the reopen: the press that books or arms it, or that it already goes then.
    const atReopen = computed(() => on.situation.value.pickUp?.atReopen);
    // The bare press on a spent account with a stopped turn waiting: book its continuation, or arm its resend.
    const reopenPress = computed(() => reopenPressOf(on.situation.value));
    return {
        atReopen,
        reopenPress,
        // What the time-labelled button says on an empty box with a turn to continue: that press, or that it is already set.
        reopenShown: computed(() => (on.intent.value === `scheduled` && continueVisible(on.situation.value) ? atReopen.value : undefined)),
        // Whether the strip's own press would get through now (a held turn always would; it is the account that may not).
        pressable: computed(() => on.situation.value.pickUp?.ready === true),
        // What Enter does on the empty box, said under it: continue now, or at the reopen the button beside it names.
        keyHint: computed(() => continueKeyHintOf(on.continueOffer.value, on.spentUntil.value, reopenPress.value, on.now.value)),
    };
};

export const useComposerSend = (host: SendHost) => {
    const { view, voiceAgent, history, editorContext } = host;
    const { draft, attachments, editing, awaitingDecision, pickUp, queued, connected, staged } = view;
    const { live, parked, planMessage } = composerTurn(view);
    const t = useT();
    const later = laterPick(host);
    // Running only while something counts down to a named instant (an allowance reset, a booked time); nothing else here
    // is timed.
    const paneNow = useNow(() => pickUp.value?.readyAt !== undefined || view.spentReopensAt.value !== undefined || later.value?.kind === `at`);
    // When the account this send would run on reopens (ms), while that is still ahead; a reset the clock has passed is a
    // stale reading, and a plain send is the honest press for it.
    const spentUntil = computed(() => {
        const at = view.spentReopensAt.value;
        return at === undefined || at * 1_000 <= paneNow.value ? undefined : at * 1_000;
    });
    // The pane's words, plus what only a scheduled send says: when, and whether a turn already waiting goes ahead of it.
    const words = computed<ComposerWords>(() => {
        // Only a sandbox that books the whole queue lets a booking go with an ordinary send (`scheduled` is a hold only
        // there, bookings.ts holdOfQueue); one that books each message keeps every booking on its time.
        const base: ComposerWords = { ...host.words.value, heldGoesToo: view.queuePaused.value === `scheduled` };
        const picked = later.value;
        const own: ComposerWords = picked === undefined ? base : { ...base, later: laterLabel(picked, paneNow.value, host.titleOf) };
        const until = spentUntil.value;
        if (until === undefined) {
            return own;
        }
        const waiting = pickUp.value?.reason === `limit` && pickUp.value.held !== undefined;
        return { ...own, reopens: formatReset(Math.round(until / 1_000), paneNow.value), followsWaiting: waiting };
    });
    // One snapshot of the composer for the ladder; the pane supplies only what a mounted chat alone has.
    const situation = computed<ComposerSituation>(() => ({
        staged: staged.value,
        attached: attachments.value.length > 0,
        uploading: attachments.value.some((entry) => entry.status === `uploading`),
        uploadFailed: attachments.value.some((entry) => entry.status === `failed`),
        voiceAgent: voiceAgent.value,
        editing: editing.value !== undefined,
        pendingPlan: planMessage.value !== undefined,
        streaming: live.value,
        awaitingDecision: parked.value,
        waitingOnYou: view.waitingOnYou.value,
        steerable: view.steerable.value,
        // Read against the clock here: the pure ladder (PickUpSituation) must not ask what time it is.
        pickUp:
            pickUp.value === undefined
                ? undefined
                : { ready: pickUpReady(pickUp.value, paneNow.value), atReopen: atReopenOf(pickUp.value, host.limitArmed.value) },
        // Not the sandbox's own words a spent allowance holds (wakesHeldUntil): they go with the held turn, so they neither
        // hide the strip that says the limit and offers Continue, nor give a bare press a queue to send that cannot go.
        queued: queued.value.length - (wakesHeldUntil(pickUp.value, view.waiting.value, paneNow.value) === undefined ? 0 : view.waiting.value.length),
        // Everything waiting is booked for later: a bare press then has nothing it may send now.
        queueScheduled: view.waiting.value.length === 0 && view.bookedGroups.value.length > 0,
        connected: connected.value,
        spentUntil: spentUntil.value,
        later: later.value !== undefined,
    }));
    const intent = computed(() => sendIntentOf(situation.value));
    // Why Send is refusing, in the user's words; undefined when the press will land.
    const refusal = computed(() => sendRefusal(situation.value));
    const continueOffer = computed(() => continueOffered(situation.value));
    const reopen = reopenReadings({ situation, intent, continueOffer, spentUntil, now: paneNow });
    const { reopenPress, reopenShown } = reopen;
    const canSend = computed(() => sendable(situation.value, intent.value, refusal.value));
    // Everything a press needs: voice and edit intercept before `canSend`.
    const readyToSend = computed(() => connected.value && staged.value && refusal.value === undefined);

    // Continuing says nothing of the person's (a held turn re-runs, or the daemon carries the session on), so nothing
    // joins the recall ring.
    const continueTurn = (options?: ContinueOptions): void => {
        if (!host.reachable.value) {
            return;
        }
        void view.continueTurn(options);
        host.pin();
    };

    const continueAtReopen = reopenContinuation(host, spentUntil, reopenPress);
    // The two things a bare press over a stopped turn does (barePressOf).
    const bareWays = { now: continueTurn, reopen: continueAtReopen };

    // Snaps the box back to one line with the caret in it: what every path that spends the draft ends with.
    const settleComposer = (): void => {
        draft.value = ``;
        void nextTick(host.refocus);
    };

    // Awaited, unlike a send: a refused place has no queue to fall into, so the words stay in the box.
    const placeDraft = async (): Promise<void> => {
        const text = draft.value.trim();
        const chat = view.conversation.value;
        if (!(await chat.transcript.placeAsAgent(text))) {
            return;
        }
        // The warmed transcript cache now ends one row early: the same signal a settled turn sends.
        invalidateAgentTranscript(chat.conversationId, chat.box.value);
        history.value?.record(text);
        // Speaking as the agent is a deliberate act each time.
        voiceAgent.value = false;
        host.pin();
        settleComposer();
    };

    // The send is the confirmation (TranscriptView.submitEdit): everything the edit destroys goes here, nowhere earlier.
    const sendEdit = (): void => {
        const replacement = draft.value.trim();
        void view.submitEdit(replacement, host.staging.snapshot(), editorContext.forSend());
        attachments.value = [];
        editorContext.include.value = false;
        history.value?.record(replacement);
        host.pin();
        settleComposer();
    };

    // One path whether or not a turn runs (TurnClient.enqueue); typed during a pending plan, the words reject it as
    // revision feedback instead. The chips go with the message, which owns their thumbnails from here. A `booking` books
    // the words for later instead (a scheduled send): they wait in the queue, and no turn opens.
    const sendDraft = (booking?: TurnBooking): void => {
        const text = draft.value.trim();
        const plan = planMessage.value?.plan;
        if (plan !== undefined) {
            void view.conversation.value.requests.reply(plan.requestId, {
                kind: `plan`,
                approve: false,
                feedback: planFeedback(text, host.staging.snapshot()),
            });
            attachments.value = [];
        } else {
            const snapshot = host.staging.snapshot();
            const context = editorContext.forSend();
            // A routed chat's opening message waits for its one reading, so the card and model are on for the turn that
            // decides the tree; every other send goes now.
            const readings = booking === undefined ? host.route.beforeSend(text, editorContext.include.value) : undefined;
            if (booking !== undefined) {
                // The funnel's milestone all the same: a booked message is a sent one, as the reader meant it.
                track(`message_sent`, { agent: view.conversation.value.selection.provider.value, scheduled: true });
                void view.conversation.value.turn.schedule(text, booking, snapshot, context);
            } else if (readings === undefined) {
                void view.send(text, snapshot, context);
            } else {
                void readings.then(() => view.send(text, snapshot, context));
            }
            attachments.value = [];
            editorContext.include.value = false;
        }
        // A bare queue-flush press sent no words of its own, so it earns no recall slot.
        if (text.length > 0) {
            history.value?.record(text);
        }
        // Writing the newest thing says the bottom is where the reader wants to be.
        host.pin();
        settleComposer();
    };

    const { approvePlan, keepPlanning } = planAnswers(host, planMessage, { settle: settleComposer, sendDraft });

    // Place and edit intercept and always return, since falling through with an empty box would misfire as Continue or an
    // appended send; then the run-through badge, then `canSend` for what's left. `now` skips the scheduling, for a caller
    // that just made room itself (a reset claimed, an account switched).
    const submit = (options: { readonly now?: boolean } = {}): void => {
        host.runThrough.clearFailures();
        if (!host.reachable.value) {
            return;
        }
        if (intent.value === `place` || intent.value === `edit`) {
            if (readyToSend.value) {
                void (intent.value === `place` ? placeDraft() : sendEdit());
            }
            return;
        }
        if (host.runThrough.claimSend()) {
            return;
        }
        // Nothing to send WITH: the draft stays, so the sentence already written is what the chosen model answers.
        if (!connected.value) {
            host.openModels();
            return;
        }
        // Nothing typed and a turn left hanging means Continue, the strip's own press by keyboard ("Enter to continue"): it
        // does exactly what that button does, so it leaves the strip's answer alone. A caller that just made room itself
        // (`now`: a reset claimed, an account switched) continues now, ahead of a spent reading the usage feed has not
        // caught up with.
        // On a spent account the same bare press continues at the reopen, as the time-labelled button it sits beside says
        // ("Enter to continue at 02:00"), rather than now, where it would be refused before anything ran.
        const bare = barePressOf(continueOffer.value, reopenPress.value, options.now === true);
        if (bare !== undefined) {
            bareWays[bare]();
            return;
        }
        if (!canSend.value) {
            return;
        }
        // A message booked for the moment the reader picked: the pick is spent by it, as a workflow badge is by its send.
        const picked = intent.value === `later` ? later.value : undefined;
        if (picked !== undefined) {
            view.conversation.value.sendLater.value = undefined;
            sendDraft(bookingOf(picked));
            return;
        }
        // A scheduled send is booked, not tried: the words wait in the queue, drawn as scheduled, and the sandbox lets them
        // go when the window reopens; nothing reaches the provider before, so there is no refusal to show. The limit answer
        // is set to resend as well, for a reopen the provider named too early (that turn is refused, and goes again at the
        // next one). A failed write leaves the card's own control saying `wait`.
        const booking = intent.value === `scheduled` && options.now !== true ? spentUntil.value : undefined;
        if (booking !== undefined) {
            // allow(silent-catch): the write is optimistic and rolls back on failure, so the card's control saying `wait` is the report.
            void host.armLimitResend().catch(() => undefined);
        }
        sendDraft(booking === undefined ? undefined : { sendAt: booking });
    };

    return {
        intent,
        ...scheduledPress({ intent, later, spentUntil, now: paneNow, words, titleOf: host.titleOf }),
        refusal,
        continueOffer,
        canSend,
        continueTurn,
        continueAtReopen,
        // The strip says what happened; the offer is the press, sharing one predicate.
        continueStrip: computed(() => continueVisible(situation.value)),
        // When the account the press runs on reopens (ms), while it reads spent: the wall the strip names beside its ending.
        spentUntil,
        pickUpPressable: reopen.pressable,
        atReopen: reopen.atReopen,
        continueKeyHint: reopen.keyHint,
        // Typed text always has somewhere to go mid-turn, but an empty box has none, so Stop takes the slot until the
        // first keystroke; gated on `staged`, so a refused send keeps its greyed button and tooltip.
        sendShown: computed(() => !live.value || staged.value),
        composerPlaceholder: computed(() => {
            if (!host.canDrive.value) {
                return viewerPlaceholder();
            }
            // Nothing to send with: the box still takes the task, without naming a vendor nobody chose.
            return connected.value ? placeholderFor(intent.value, words.value) : unconnectedPlaceholder();
        }),
        sendHint: computed((): TooltipValue => {
            if (!host.reachable.value) {
                return { title: t(`chat.chatPane.sandboxBusy`), tone: `warning`, note: t(`chat.chatPane.keepTyping`) };
            }
            // What the press does with nothing connected: opens the model list, keeping the draft.
            if (!connected.value) {
                return unconnectedHint();
            }
            // A refusal's sentence is the status line's; the greyed button names it.
            const refused = sendRefusalTitle(situation.value);
            if (refused !== undefined) {
                return { title: refused, tone: `warning` };
            }
            // An empty box over a stopped turn: the time-labelled press continues it then, or says it already goes then.
            const shown = reopenShown.value;
            return shown === undefined ? sendHintFor(intent.value, words.value) : reopenHintFor(shown, words.value);
        }),
        // Offered for every live turn, a parked one included, naming what goes with it there.
        stopLabel: computed(() => (awaitingDecision.value ? t(`chat.composerSend.stopTheTurn`) : t(`chat.composerSend.stopGenerating`))),
        stopHint: computed((): TooltipValue => {
            if (awaitingDecision.value) {
                return { title: t(`chat.composerIntent.stopTurn`), note: t(`chat.composerIntent.discardsRequest`) };
            }
            return host.mobile.value ? t(`ui.action.stop`) : { title: t(`ui.action.stop`), keys: t(`ui.keys.esc`) };
        }),
        submit,
        approvePlan,
        keepPlanning,
    };
};
