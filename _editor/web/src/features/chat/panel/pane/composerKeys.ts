import { useT } from "@intentic/ui/i18n";
import { computed, type ComputedRef, type Ref, watch } from "vue";
import { useSandbox } from "../../../sandbox/client/useSandbox";
import type { ComposerVoice } from "../../composer/useComposerVoice";
import { type InputHistory, inputHistoryFor, recallStep } from "../../drafts/inputHistory";
import type { Conversation } from "../../session/conversation";
import type { ConversationView } from "../useChat-view";
import type { ComposerPopovers } from "./composerPopovers";

// One pane's composer keyboard: who gets each key, in order (an open list, then recall, then Escape's own ladder, then
// Enter), what a keystroke of the user's own ends, and the one hint slot that teaches whichever key matters now.

// The sandbox's recall ring (up/down/Escape), resolved per sandbox so switching sandboxes switches rings.
export const useRecallRing = (conversation: () => Conversation): ComputedRef<InputHistory | undefined> => {
    const { activeSandboxId } = useSandbox();
    const history = computed(() => (activeSandboxId.value === undefined ? undefined : inputHistoryFor(activeSandboxId.value)));
    // A tab or sandbox switch resets both rings, so down/Escape can't paste one tab's draft into another's.
    watch([conversation, history], (_current, [, previousHistory]) => {
        previousHistory?.reset();
        history.value?.reset();
    });
    return history;
};

// A popover's list as the keyboard drives it.
export interface PopoverList {
    readonly move: (delta: number) => void;
    // Whether a row was actually picked: with none active, the key belongs to the composer.
    readonly pickActive: () => boolean;
}

export interface KeysHost {
    readonly view: ConversationView;
    readonly input: Readonly<Ref<HTMLTextAreaElement | null>>;
    readonly history: Readonly<Ref<InputHistory | undefined>>;
    readonly popovers: Pick<
        ComposerPopovers,
        "mentionOpen" | "commandOpen" | "popoverDismissed" | "recallInto" | "caret" | "syncCaret" | "commandRun"
    >;
    // The two lists' own components, whichever one is open.
    readonly lists: { readonly mention: Readonly<Ref<PopoverList | undefined>>; readonly command: Readonly<Ref<PopoverList | undefined>> };
    readonly voice: Pick<ComposerVoice, "live" | "quit" | "slotHint">;
    readonly reachable: Readonly<Ref<boolean>>;
    readonly mobile: Readonly<Ref<boolean>>;
    readonly continueOffer: Readonly<Ref<boolean>>;
    readonly grow: () => void;
    readonly submit: () => void;
}

export const useComposerKeys = (host: KeysHost) => {
    const { view, popovers, history } = host;
    const { draft, streaming, awaitingDecision } = view;
    const t = useT();

    // True when recall consumed the key; claims nothing while text is selected, since arrows then collapse the
    // selection. Reads the live element, not the `caret` ref, which goes stale under an auto-repeating arrow.
    const recallKeydown = (event: KeyboardEvent): boolean => {
        const past = history.value;
        const el = host.input.value;
        if (past === undefined || el === null || el.selectionStart !== el.selectionEnd) {
            return false;
        }
        const step = recallStep(past, event.key, draft.value, el.selectionStart);
        if (step === undefined) {
            return false;
        }
        event.preventDefault();
        if (step.kind === `text`) {
            popovers.recallInto(step.text);
            return true;
        }
        el.setSelectionRange(step.at, step.at);
        popovers.caret.value = step.at;
        // The step lands on an edge past the box's scroll; without this the caret would leave the visible rows.
        el.scrollTop = step.at === 0 ? 0 : el.scrollHeight;
        return true;
    };

    // An open list owns its keys; unclaimed ones fall through, so Shift+Enter still inserts a newline.
    const POPOVER_KEYS: Record<string, (list: PopoverList, event: KeyboardEvent) => boolean> = {
        ArrowDown: (list) => {
            list.move(1);
            return true;
        },
        ArrowUp: (list) => {
            list.move(-1);
            return true;
        },
        Escape: () => {
            popovers.popoverDismissed.value = true;
            return true;
        },
        Enter: (list, event) => !event.shiftKey && list.pickActive(),
        Tab: (list) => list.pickActive(),
    };
    const popoverKeydown = (event: KeyboardEvent): boolean => {
        const list = popovers.mentionOpen.value ? host.lists.mention.value : popovers.commandOpen.value ? host.lists.command.value : undefined;
        return list !== undefined && POPOVER_KEYS[event.key]?.(list, event) === true;
    };

    // Escape, after the lists and recall had their claim: voice catches a counting-down send and quits hands-free; an
    // armed edit is abandoned (free: nothing changed); only then does it stop a turn that is generating, since a
    // card-parked turn spends nothing and Stop is the way out of it instead.
    const escapeKeydown = (): boolean => {
        if (host.voice.live.value) {
            host.voice.quit();
            return true;
        }
        if (view.editing.value !== undefined) {
            view.conversation.value.transcript.cancelEdit();
            return true;
        }
        if (!streaming.value || awaitingDecision.value || !host.reachable.value) {
            return false;
        }
        view.conversation.value.turn.stop();
        return true;
    };

    // Enter (or Cmd/Ctrl+Enter) sends and Shift+Enter breaks the line; on a phone Enter is the newline, since its
    // keyboard has no Shift+Enter and the send button submits.
    const sends = (event: KeyboardEvent): boolean =>
        event.key === `Enter` && !host.mobile.value && !(event.shiftKey && !event.metaKey && !event.ctrlKey);

    const recallable = computed(() => draft.value === `` && history.value?.recallable === true);

    return {
        onKeydown: (event: KeyboardEvent): void => {
            // Never submit mid-IME-composition: CJK candidates confirm with Enter.
            if (event.isComposing) {
                return;
            }
            if (popoverKeydown(event)) {
                event.preventDefault();
                return;
            }
            // After the lists: an open list owns the arrows, and recall's Escape mustn't pre-empt dismissing it.
            if (recallKeydown(event)) {
                return;
            }
            if (event.key === `Escape`) {
                if (escapeKeydown()) {
                    event.preventDefault();
                }
                return;
            }
            if (!sends(event)) {
                return;
            }
            event.preventDefault();
            host.submit();
        },
        // Typing reclaims a recalled draft as the user's own and catches an armed voice send; only real keystrokes reach
        // here, since programmatic writes go through v-model with no input event.
        onInput: (): void => {
            host.grow();
            popovers.syncCaret();
            host.voice.quit();
            history.value?.reset();
        },
        // An empty box can't take a newline but can take a recall, so the slot advertises whichever key is live.
        composerHint: computed(() => {
            // Live voice outranks everything: while it's on, Escape means "catch the mic", not "stop streaming".
            const spoken = host.voice.slotHint.value;
            if (spoken !== undefined) {
                return spoken;
            }
            // While generating, the way out is the shortcut worth the slot: the only place Escape's meaning is learned.
            if (streaming.value && !awaitingDecision.value) {
                return t(`chat.chatPane.escToStop`);
            }
            // A draft that runs as a command sends nothing to the model, so say so before Enter, not after.
            const command = popovers.commandRun.value;
            if (command !== undefined) {
                return t(`chat.chatPane.enterRunsCommand`, { name: command.name });
            }
            // Ranked ahead of recall: rarer, more useful, and the one place anyone learns the key exists.
            if (host.continueOffer.value) {
                return t(`chat.chatPane.enterToContinue`);
            }
            if (recallable.value) {
                return t(`chat.chatPane.upForPreviousMessage`);
            }
            return draft.value === `` ? t(`chat.chatPane.atForFilesAndSettings`) : t(`chat.chatPane.shiftEnterNewLine`);
        }),
    };
};
