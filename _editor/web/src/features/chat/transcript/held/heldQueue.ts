import { basename } from "@intentic/ui/path";
import { computed } from "vue";
import { usePaneView } from "../../panel/useChat-view";
import type { ChatMessage } from "../transcript";

// A message that did not go out, as the chat draws it: the words wait in the conversation's queue (held), or the sandbox
// kept the turn whole with its message above (`sandboxHeld`). Either way the reader sees their message, that it was not
// sent, and one press, instead of a notice, a bar and a card that each said part of it.

/**
 * Why a message waits, in the chat's words: low memory, another refusal at the door, a stop, or a scheduled send
 * booked for its own time (the one the reader asked for, and the one that ends by itself; each booked message has its
 * own, ChatHeldBooking).
 */
export type HoldReason = `memory` | `refused` | `stopped` | `scheduled`;

/** The row a low-memory refusal leaves (transcript-fold's memoryPress): the only refusal the chat can word itself. */
export const isMemoryHold = (message: ChatMessage): boolean =>
    message.role === `notice` && (message.noticeAction === `sendAnyway` || message.noticeAction === `sandboxMemory`);

/**
 * What a low-memory row says was short, as the sandbox measured it: its first sentence, which memoryTip reads the
 * figures out of. The stakes after it are the press's own hover (sendAnywayTip).
 */
export const memoryReading = (text: string): string => {
    const end = text.search(/\.\s/);
    return end === -1 ? text : text.slice(0, end + 1);
};

/**
 * The last row the sandbox wrote. This window's own notices after it (the "switched" divider an account pick draws, a
 * local "Stopped.") say nothing ran since, so they never take a held row's press away: picking another account under a
 * kept turn is exactly when its press is wanted.
 */
const lastSaid = (messages: readonly ChatMessage[]): ChatMessage | undefined => messages.findLast((entry) => entry.local !== true);

/** Whether a row is still the last thing in its conversation, nothing having run since. */
const standing = (messages: readonly ChatMessage[], message: ChatMessage): boolean => lastSaid(messages)?.id === message.id;

/**
 * The pane's held queue: whether a Stop or a refusal holds the messages no booking holds back, the low-memory row it is
 * about, and why. The row is the transcript's last only while the queue still holds its words, which is when the held
 * message's own line says it, so the transcript draws it there and not a second time as a notice. Booked messages are
 * not this hold's: each group of them has its own line (useChat-view's bookedGroups).
 */
export const useHeldQueue = () => {
    const { messages, waiting, queuePaused, lastFailure } = usePaneView();
    const held = computed(() => (queuePaused.value === `stopped` || queuePaused.value === `refused`) && waiting.value.length > 0);
    const notice = computed(() => {
        const last = lastSaid(messages.value);
        return held.value && queuePaused.value === `refused` && last !== undefined && isMemoryHold(last) && last.sandboxHeld !== true ? last : undefined;
    });
    // A chat opened a minute after the refusal has no row for it (a turn that ran nothing is never recorded), so the
    // board's card is the one place left that says it was memory: its failure, which the next run clears.
    const cardMemory = computed(() => (queuePaused.value === `refused` && lastFailure.value?.code === `sandbox-memory-low` ? lastFailure.value : undefined));
    const reason = computed<Exclude<HoldReason, `scheduled`>>(() => {
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
