import type { EditorContext } from "@intentic/sandbox-contract";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, type Ref } from "vue";
import {
    type ComposerSituation,
    type ComposerWords,
    continueOffered,
    continueVisible,
    placeholderFor,
    sendable,
    sendHintFor,
    sendIntentOf,
    sendRefusal,
    unconnectedHint,
    unconnectedPlaceholder,
    viewerPlaceholder,
} from "../../composer/composerIntent";
import type { InputHistory } from "../../drafts/inputHistory";
import type { RunThrough } from "../../models/run-settings/useRunThrough";
import type { ChatRouting } from "../../routing/chatRoute";
import { pickUpReady } from "../../run/pickUp";
import { planFeedback } from "../../session/cardReplies";
import { invalidateAgentTranscript } from "../../transcript/agentTranscript";
import type { ChatAttachment } from "../../transcript/transcript";
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
}

export const useComposerSend = (host: SendHost) => {
    const { view, voiceAgent, history, editorContext } = host;
    const { draft, attachments, editing, pendingPlanMessage, streaming, awaitingDecision, pickUp, queued, connected, staged } = view;
    const t = useT();
    // Running only while a pick-up counts down to a named instant (an allowance reset); nothing else here is timed.
    const paneNow = useNow(() => pickUp.value?.readyAt !== undefined);
    // One snapshot of the composer for the ladder; the pane supplies only what a mounted chat alone has.
    const situation = computed<ComposerSituation>(() => ({
        staged: staged.value,
        attached: attachments.value.length > 0,
        uploading: attachments.value.some((entry) => entry.status === `uploading`),
        uploadFailed: attachments.value.some((entry) => entry.status === `failed`),
        voiceAgent: voiceAgent.value,
        editing: editing.value !== undefined,
        pendingPlan: pendingPlanMessage.value !== undefined,
        streaming: streaming.value,
        awaitingDecision: awaitingDecision.value,
        steerable: view.steerable.value,
        // Read against the clock here: the pure ladder (PickUpSituation) must not ask what time it is.
        pickUp: pickUp.value === undefined ? undefined : { ready: pickUpReady(pickUp.value, paneNow.value) },
        queued: queued.value.length,
        connected: connected.value,
    }));
    const intent = computed(() => sendIntentOf(situation.value));
    // Why Send is refusing, in the user's words; undefined when the press will land.
    const refusal = computed(() => sendRefusal(situation.value));
    const continueOffer = computed(() => continueOffered(situation.value));
    const canSend = computed(() => sendable(situation.value, intent.value, refusal.value));
    // Everything a press needs: voice and edit intercept before `canSend`.
    const readyToSend = computed(() => connected.value && staged.value && refusal.value === undefined);

    // Continuing may re-run a held turn rather than send; only a sent continuation joins the recall ring.
    const continueTurn = (options?: { readonly carry?: boolean }): void => {
        if (!host.reachable.value) {
            return;
        }
        void view.continueTurn(options).then((sent) => {
            if (sent !== undefined) {
                history.value?.record(sent);
            }
        });
        host.pin();
    };

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
    // revision feedback instead. The chips go with the message, which owns their thumbnails from here.
    const sendDraft = (): void => {
        const text = draft.value.trim();
        const pendingPlan = pendingPlanMessage.value?.plan;
        if (pendingPlan !== undefined) {
            void view.conversation.value.requests.reply(pendingPlan.requestId, {
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
            const readings = host.route.beforeSend(text, editorContext.include.value);
            if (readings === undefined) {
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

    return {
        intent,
        refusal,
        continueOffer,
        canSend,
        continueTurn,
        // The strip says what happened; the offer is the press, sharing one predicate.
        continueStrip: computed(() => continueVisible(situation.value)),
        // Typed text always has somewhere to go mid-turn, but an empty box has none, so Stop takes the slot until the
        // first keystroke; gated on `staged`, so a refused send keeps its greyed button and tooltip.
        sendShown: computed(() => !streaming.value || staged.value),
        composerPlaceholder: computed(() => {
            if (!host.canDrive.value) {
                return viewerPlaceholder();
            }
            // Nothing to send with: the box still takes the task, without naming a vendor nobody chose.
            return connected.value ? placeholderFor(intent.value, host.words.value) : unconnectedPlaceholder();
        }),
        sendHint: computed(() => {
            if (!host.reachable.value) {
                return t(`chat.chatPane.sandboxBusyKeepTyping`);
            }
            // What the press does with nothing connected: opens the model list, keeping the draft.
            if (!connected.value) {
                return unconnectedHint();
            }
            return refusal.value ?? sendHintFor(intent.value, host.words.value);
        }),
        // Offered for every live turn, a parked one included, naming what goes with it there.
        stopLabel: computed(() => (awaitingDecision.value ? `Stop the turn` : `Stop generating`)),
        stopHint: computed(() => {
            if (awaitingDecision.value) {
                return `Stop the turn, discards the request above`;
            }
            return host.mobile.value ? `Stop generating` : `Stop generating (Esc)`;
        }),
        // What will happen to the waiting messages: a parked turn takes them once answered, a running one ends first, and
        // with nothing running here they go as soon as the agent is free.
        queuedHint: computed(() => {
            if (!streaming.value) {
                return t(`chat.chatQueue.goesWhenFree`);
            }
            return awaitingDecision.value ? t(`chat.chatQueue.goesAfterAnswer`) : t(`chat.chatQueue.goesAfterTurn`);
        }),
        // Place and edit intercept and always return, since falling through with an empty box would misfire as Continue
        // or an appended send; then the run-through badge, then `canSend` for what's left.
        submit: (): void => {
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
            if (!canSend.value) {
                return;
            }
            // Nothing typed and a turn left hanging means Continue: every gate below reads a draft that isn't there.
            if (continueOffer.value) {
                continueTurn();
                return;
            }
            sendDraft();
        },
        // Keep both: forks "now" at the cut the edit aimed at, so the new tab inherits everything above and opens with
        // the original prompt, while this pane keeps the half-written replacement. An escape hatch, never destructive.
        forkInsteadOfEdit: (): void => {
            const target = editing.value;
            const cut = target === undefined ? -1 : view.messages.value.indexOf(target);
            if (cut < 0) {
                return;
            }
            const carried = draft.value;
            const chips = attachments.value;
            // Ends the edit first, so this pane's composer returns to what the pencil displaced before the fork.
            view.conversation.value.transcript.cancelEdit();
            const fork = view.forkAt(cut, `now`);
            if (fork !== undefined) {
                fork.draft.value = carried;
                fork.attachments.value = [...chips];
            }
        },
    };
};
