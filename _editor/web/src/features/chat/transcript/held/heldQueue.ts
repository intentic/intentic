import { basename } from "@intentic/ui/path";
import { computed } from "vue";
import { usePaneView } from "../../panel/useChat-view";
import type { ChatMessage } from "../transcript";

// A message that did not go out, as the chat draws it: the words wait in the conversation's queue (held), or the sandbox
// kept the turn whole with its message above (`sandboxHeld`). Either way the reader sees their message, that it was not
// sent, and one press, instead of a notice, a bar and a card that each said part of it.

/** Why what waits is held, in the chat's words: low memory, another refusal at the door, or a stop. */
export type HoldReason = `memory` | `refused` | `stopped`;

/** The row a low-memory refusal leaves (transcript-fold's memoryPress): the only refusal the chat can word itself. */
export const isMemoryHold = (message: ChatMessage): boolean =>
    message.role === `notice` && (message.noticeAction === `sendAnyway` || message.noticeAction === `sandboxMemory`);

/**
 * What a low-memory row says was short, as the sandbox measured it: its first sentence. The stakes after it are the
 * press's own hover (`sendAnywayHint`), and a hover label is only a few lines long.
 */
export const memoryReading = (text: string): string => {
    const end = text.search(/\.\s/);
    return end === -1 ? text : text.slice(0, end + 1);
};

/** Whether a row is still the last thing in its conversation, nothing having run since. */
const standing = (messages: readonly ChatMessage[], message: ChatMessage): boolean => messages.at(-1)?.id === message.id;

/**
 * The pane's held queue: whether anything is held, the low-memory row it is about, and why. The row is the
 * transcript's last only while the queue still holds its words, which is when the held message's own line says it,
 * so the transcript draws it there and not a second time as a notice.
 */
export const useHeldQueue = () => {
    const { messages, queued, queuePaused, lastFailure } = usePaneView();
    const held = computed(() => queuePaused.value !== undefined && queued.value.length > 0);
    const notice = computed(() => {
        const last = messages.value.at(-1);
        return held.value && queuePaused.value === `refused` && last !== undefined && isMemoryHold(last) && last.sandboxHeld !== true ? last : undefined;
    });
    // A chat opened a minute after the refusal has no row for it (a turn that ran nothing is never recorded), so the
    // board's card is the one place left that says it was memory: its failure, which the next run clears.
    const cardMemory = computed(() => (queuePaused.value === `refused` && lastFailure.value?.code === `sandbox-memory-low` ? lastFailure.value : undefined));
    const reason = computed<HoldReason>(() => {
        if (notice.value !== undefined || cardMemory.value !== undefined) {
            return `memory`;
        }
        return queuePaused.value === `stopped` ? `stopped` : `refused`;
    });
    // What was short, as the sandbox measured it, for the reason's hover.
    const detail = computed(() => {
        const said = notice.value?.text ?? cardMemory.value?.text;
        return said === undefined ? undefined : memoryReading(said);
    });
    return { held, notice, reason, detail };
};

/**
 * A turn the sandbox kept after the door turned it away (a fix press, a peer's message): whether it still waits on
 * this row, and the press that runs it as it was started, its message being the one above.
 */
export const useKeptTurn = (message: () => ChatMessage) => {
    const { conversation, streaming, messages } = usePaneView();
    const waiting = computed(() => !streaming.value && message().sandboxHeld === true && standing(messages.value, message()));
    const send = (): Promise<void> => {
        const row = message();
        const kept = messages.value.findLast((entry) => entry.run === row.run && entry.role === `user`);
        return conversation.value.turn.resendKept({
            text: kept?.text ?? ``,
            attachments: (kept?.attachments ?? []).map((path) => ({ name: basename(path), path })),
        });
    };
    return { waiting, send };
};
