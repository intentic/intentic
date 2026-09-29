import { sandboxShallowRef } from "@intentic/extension-api";
import { watch } from "vue";

// Files handed to a chat from outside its composer (the desktop app's "Ask an agent about this", localHandoffArrival.ts),
// waiting for that chat's composer to take them. A composer is a per-pane composable (useChatAttachments), so the file
// cannot be attached from where it arrives: it is queued here under the conversation it is for, and the composer showing
// that conversation takes it on mount, or when it lands, through its own `attach` like a drop or a paste.

export interface QueuedAttachment {
    readonly conversationId: string;
    readonly file: File;
    // Told once the composer has taken the file, so the arrival can say so only when it is true.
    readonly taken?: () => void;
}

// One sandbox's conversations' files, so a switch lets go of any the old sandbox's composers never took.
const queue = sandboxShallowRef<readonly QueuedAttachment[]>(() => []);

/** Queues a file for the composer of `conversationId`. */
export const queueAttachment = (entry: QueuedAttachment): void => {
    queue.value = [...queue.value, entry];
};

/** The files queued for `conversationId`, in the order they came, taken out of the queue. */
export const takeQueuedAttachments = (conversationId: string): readonly QueuedAttachment[] => {
    const taken = queue.value.filter((entry) => entry.conversationId === conversationId);
    if (taken.length > 0) {
        queue.value = queue.value.filter((entry) => entry.conversationId !== conversationId);
    }
    return taken;
};

/**
 * A composer's half: takes what is queued for its conversation into `attach`, on mount and whenever the queue or its
 * conversation changes, once it can take files at all (`reachable`: an upload needs the daemon).
 */
export const useQueuedAttachments = (composer: {
    readonly conversationId: () => string;
    readonly reachable: () => boolean;
    readonly attach: (file: File) => void;
}): void => {
    watch(
        [queue, composer.conversationId, composer.reachable],
        ([, conversationId, reachable]) => {
            if (!reachable) {
                return;
            }
            for (const entry of takeQueuedAttachments(conversationId)) {
                composer.attach(entry.file);
                entry.taken?.();
            }
        },
        { immediate: true },
    );
};
