import type { ListenerStop, ListenerStopAnswer } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import type { ReplyRegistry, RunControl } from "./chat-reply.js";
import type { Logger } from "./log.js";

// What a chat gateway remembers about the turns it is answering: which are running (so a Stop button and a message
// steered into a thread find their turn), and which threads it answered in (so a follow-up there is heard without a
// mention). Both live in the process and are forgotten on restart, where the platform's own record (a thread the bot
// owns, its earlier posts in a thread) takes over.

export interface RunRegistry extends ReplyRegistry {
    readonly byConversation: (conversationId: string) => RunControl | undefined;
    // The conversation whose turn is running where it lives, for a Stop that names the place rather than the
    // conversation (a reaction on the request, a stream the person stopped in the chat's own UI).
    readonly conversationAt: (place: string) => string | undefined;
}

export const runRegistry = (): RunRegistry => {
    const byConversation = new Map<string, RunControl>();
    const byPlace = new Map<string, { readonly conversationId: string; readonly run: RunControl }>();
    return {
        opened: (conversationId, place, run) => {
            byConversation.set(conversationId, run);
            byPlace.set(place, { conversationId, run });
        },
        closed: (conversationId, place) => {
            byConversation.delete(conversationId);
            if (byPlace.get(place)?.conversationId === conversationId) {
                byPlace.delete(place);
            }
        },
        running: (place) => byPlace.get(place)?.run,
        byConversation: (id) => byConversation.get(id),
        conversationAt: (place) => byPlace.get(place)?.conversationId,
    };
};

// Threads this process answered in, the most recent kept, bounded.
export interface JoinedThreads {
    readonly has: (id: string) => boolean;
    readonly add: (id: string) => void;
}

export const JOINED_THREADS_MAX = 2_000;

export const joinedThreads = (max: number = JOINED_THREADS_MAX): JoinedThreads => {
    const ids = new Set<string>();
    return {
        has: (id) => ids.has(id),
        add: (id) => {
            ids.delete(id);
            ids.add(id);
            const oldest = ids.size > max ? ids.values().next().value : undefined;
            if (oldest !== undefined) {
                ids.delete(oldest);
            }
        },
    };
};

// A person in the channel pressed a status card's Stop: the daemon decides whether they may, by the automation's own
// sender rules, and a stopped turn's card says who stopped it. Answers the sentence to show the person who pressed it.
export const stopFromChat = async (
    daemon: { readonly stop: (stop: ListenerStop) => Promise<ListenerStopAnswer> },
    runs: Pick<RunRegistry, "byConversation">,
    stop: ListenerStop,
    shownAs: string,
    log: Logger,
): Promise<string> => {
    const answer = await daemon.stop(stop).catch((error: Error) => {
        log.warn({ err: error }, "stop: the daemon did not answer");
        return { stopped: false, reason: "I couldn't reach the sandbox to stop it; try again in a moment." };
    });
    if (!answer.stopped) {
        return answer.reason ?? "That one can't be stopped from here.";
    }
    runs.byConversation(stop.conversationId)?.stopping(shownAs);
    return "Stopping it now.";
};
