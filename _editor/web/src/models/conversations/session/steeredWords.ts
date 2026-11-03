import type { MessageReceipt } from "@intentic/sandbox-contract/schemas/agent";
import { watch } from "vue";
import type { AttachHead } from "../../../client/sandbox/streams/turnStream";
import { importOrReload } from "../../../lib/staleChunk";
import type { ChatMessage } from "../transcript/transcript";
import type { TurnClient } from "./turnClient";
import type { TurnHost } from "./turnHost";

/* WORDS SAID INTO A TURN THIS WINDOW DOES NOT FOLLOW. A send from a window that is not attached to the conversation's
   live turn (another window or device started it, a wake did, the resume pass did) draws its bubble as any send does,
   and the daemon says the words into that turn. The bubble used to go at that answer, before this window had attached to
   the turn whose rows carry the words: on 2026-10-28 (snug-condor-4nbi) it went 83 ms after the press, the words read as
   never sent, and the person sent them again. So it stays until this window is attached to the run that took them,
   whose head draws them as the daemon's own row. Not attached to it (nothing runs any more, the sandbox could not be
   asked, another run holds the conversation now), the words stay as they are and the chat is read again, which brings
   them as the record has them; the bubble goes once the daemon's row for them is drawn here. Words queued behind a turn
   need none of this: the conversation's queue, which every window shows, holds them, and their bubble goes at once. */

// Sees each head an attach takes, just before it is drawn (TurnClient.reattach).
export type Heard = (head: AttachHead) => void;

// Words the daemon said into a run already going: their bubble here, the run it named, and the id they went out under,
// which the daemon's own row for them carries.
export interface Steered {
    readonly bubble: number;
    readonly run: string | undefined;
    readonly messageId: string;
}

// Where words went that another turn holds: said into it (`steered`, followed by followSteered), or queued behind it.
export interface LeftTo {
    readonly steered?: Steered;
}

type Bubbles = Pick<TurnHost[`transcript`], "messages" | "dropLocal">;

/** What became of words another turn holds, as the daemon answered: a queued message's bubble goes now, a steered one's waits. */
export const leftTo = (transcript: Bubbles, receipt: MessageReceipt, bubble: number, messageId: string): LeftTo => {
    if (receipt.delivered === `steered`) {
        return { steered: { bubble, run: receipt.run, messageId } };
    }
    transcript.dropLocal(bubble);
    return {};
};

// A kept bubble goes once the daemon's own row for its words (the message's id) is drawn here, by an attach or a read of
// the record; a redraw that already put a recorded row in its place, or took it away, ends the wait as well.
const keepUntilRecorded = (transcript: Bubbles, { bubble, messageId }: Steered): void => {
    const settled = (messages: readonly ChatMessage[]): boolean => {
        const standing = messages.find((message) => message.id === bubble);
        if (standing === undefined || standing.run !== undefined || standing.rowId !== undefined) {
            return true;
        }
        if (!messages.some((message) => message.messageId === messageId && message.id !== bubble)) {
            return false;
        }
        transcript.dropLocal(bubble);
        return true;
    };
    if (settled(transcript.messages.value)) {
        return;
    }
    const stop = watch(
        () => transcript.messages.value,
        (messages) => {
            if (settled(messages)) {
                stop();
            }
        },
    );
};

// The chat whose turn this is, read again the way every catch-up reads it (useChat-sessions.hydrateOnce): the record from
// where this window's copy ends, then the run live now. Late imported: the sessions module reaches back into the tabs,
// whose conversations hold the turn.
const readAgain = (turn: Pick<TurnClient, "reattach">): void =>
    importOrReload(
        () => Promise.all([import(`../tabs/useChat-tabs`), import(`../run/useChat-sessions`)]),
        ([tabs, sessions]) => {
            const chat = tabs.conversations.value.find((conversation) => conversation.turn === turn);
            if (chat !== undefined) {
                sessions.hydrateOnce(chat);
            }
        },
    );

/** Follows the run steered words went into, their bubble kept until this window is attached to it (see above). */
export const followSteered = async (turn: Pick<TurnClient, "reattach">, transcript: Bubbles, steered: Steered): Promise<void> => {
    let shown = false;
    await turn.reattach(undefined, (head) => {
        if (!shown && (steered.run === undefined || head.run === steered.run)) {
            shown = true;
            transcript.dropLocal(steered.bubble);
        }
    });
    if (!shown) {
        keepUntilRecorded(transcript, steered);
        readAgain(turn);
    }
};
