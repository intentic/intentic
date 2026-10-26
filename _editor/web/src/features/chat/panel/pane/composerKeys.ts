import { useT } from "@intentic/ui/i18n";
import { computed, type ComputedRef, type Ref, watch } from "vue";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import type { ComposerVoice } from "../../composer/voice/useComposerVoice";
import { useSpeechPlayer } from "../../../../models/voice/speechPlayer";
import { type InputHistory, inputHistoryFor, recallStep } from "../../drafts/inputHistory";
import type { Conversation } from "../../../../models/conversations/session/conversation";
import type { ConversationView } from "../../../../models/conversations/panel/useChat-view";
import type { ComposerPopovers } from "./composerPopovers";
import { composingKey, primaryHeld } from "@intentic/ui/keys";
import { formatChord, isApplePlatform } from "../../../../workbench/commands/keybindings";

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
    readonly grow: () => void;
    // The pane's Send (composerSend.ts): what Enter does on an empty box over a stopped turn (continue now, or at a spent
    // account's reopen) as a sentence, undefined when it does neither; the press; and Cmd/Ctrl+Enter's draft for a new
    // agent (freshAgentSend.ts): whether the key would open one, and the press itself.
    readonly send: {
        readonly continueKeyHint: Readonly<Ref<string | undefined>>;
        readonly submit: () => void;
        readonly freshAgent: { readonly offered: Readonly<Ref<boolean>>; readonly start: () => boolean };
    };
}

// An empty box can't take a newline but can take a recall, so the slot advertises whichever key is live.
const composerHintOf = (host: KeysHost): ComputedRef<string> => {
    const { view, popovers, history } = host;
    const { draft, streaming, awaitingDecision } = view;
    const t = useT();
    const recallable = computed(() => draft.value === `` && history.value?.recallable === true);
    return computed(() => {
        // Live voice outranks everything: while it's on, Escape means "catch the mic", not "stop streaming".
        const spoken = host.voice.slotHint.value;
        if (spoken !== undefined) {
            return spoken;
        }
        // While generating, the way out is the shortcut worth the slot: the only place Escape's meaning is learned. A
        // turn already ending has nothing left to stop.
        if (streaming.value && view.ending.value === undefined && !awaitingDecision.value) {
            return t(`chat.chatPane.escToStop`);
        }
        // A draft that runs as a command sends nothing to the model, so say so before Enter, not after.
        const command = popovers.commandRun.value;
        if (command !== undefined) {
            return t(`chat.chatPane.enterRunsCommand`, { name: command.name });
        }
        // Ranked ahead of recall: rarer, more useful, and the one place anyone learns the key exists.
        const continuing = host.send.continueKeyHint.value;
        if (continuing !== undefined) {
            return continuing;
        }
        if (recallable.value) {
            return t(`chat.chatPane.upForPreviousMessage`);
        }
        if (draft.value === ``) {
            return t(`chat.chatPane.atForFilesAndSettings`);
        }
        // The one place anyone learns the new-agent key, said only while it would open one. A Mac reads the keys as its
        // menus draw them (⇧↩, ⌘↩); elsewhere as the reader's language names them.
        const isMac = isApplePlatform();
        const newline = isMac ? formatChord(`Shift+Enter`, true) : t(`chat.chatPane.shiftEnterKeys`);
        return host.send.freshAgent.offered.value
            ? t(`chat.chatPane.shiftEnterOrNewAgent`, { newline, chord: formatChord(`Mod+Enter`, isMac) })
            : t(`chat.chatPane.shiftEnterNewLine`, { newline });
    });
};

export const useComposerKeys = (host: KeysHost) => {
    const { view, popovers, history } = host;
    const { draft, streaming, awaitingDecision } = view;

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

    const speech = useSpeechPlayer();
    // Escape, after the lists and recall had their claim: voice catches a counting-down send and quits hands-free; an
    // armed edit is abandoned (free: nothing changed); only then does it stop a turn that is generating, since a
    // card-parked turn spends nothing and Stop is the way out of it instead, and one already ending has nothing to stop.
    const escapeKeydown = (): boolean => {
        // A reply being read aloud is the first thing Escape silences; hands-free stays on for the next thing said.
        if (speech.speaking.value !== undefined) {
            speech.stop();
            return true;
        }
        if (host.voice.live.value) {
            host.voice.quit();
            return true;
        }
        if (view.editing.value !== undefined) {
            view.conversation.value.transcript.cancelEdit();
            return true;
        }
        if (!streaming.value || view.ending.value !== undefined || awaitingDecision.value || !host.reachable.value) {
            return false;
        }
        view.conversation.value.turn.stop();
        return true;
    };

    // Enter sends and Shift+Enter breaks the line; Cmd/Ctrl+Enter opens a new agent with the draft where one is offered,
    // and sends here otherwise. On a phone Enter is the newline, since its keyboard has no Shift+Enter and the send
    // button submits.
    const sends = (event: KeyboardEvent): boolean =>
        event.key === `Enter` && !host.mobile.value && !(event.shiftKey && !event.metaKey && !event.ctrlKey);

    return {
        onKeydown: (event: KeyboardEvent): void => {
            // Never submit mid-IME-composition: CJK candidates confirm with Enter, which Safari delivers after the
            // composition ended (composingKey).
            if (composingKey(event)) {
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
            // A draft that runs as a slash command acts on this chat, never a new one.
            if (primaryHeld(event) && popovers.commandRun.value === undefined && host.send.freshAgent.start()) {
                return;
            }
            host.send.submit();
        },
        // Typing reclaims a recalled draft as the user's own and catches an armed voice send; only real keystrokes reach
        // here, since programmatic writes go through v-model with no input event.
        onInput: (): void => {
            host.grow();
            popovers.syncCaret();
            host.voice.quit();
            history.value?.reset();
        },
        composerHint: composerHintOf(host),
    };
};
