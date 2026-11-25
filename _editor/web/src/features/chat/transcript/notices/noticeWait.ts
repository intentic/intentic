import { useAgents } from "../../../../models/fleet/useAgents";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import { chatRouteWait } from "../../routing/chatRoute";

/* THE WAIT A NOTICE NAMES, while it still runs (TranscriptRow.noticeWait). Each kind is asked of whoever owns that wait,
   since none of them is a field on the row: an instant that may not exist yet. A wait nobody owns any more has no clock,
   which is how a settled row stops ticking, and how the transcript's layout moves it onto its turn's receipt. */

export interface PendingWait {
    readonly at: number;
    // Up from when it began, or down to its deadline (a watch: the next moment this conversation definitely moves).
    readonly counts: `up` | `down`;
}

const clock = (instant: number | undefined, counts: `up` | `down`): PendingWait | undefined => (instant === undefined ? undefined : { at: instant, counts });

/** The wait each row names, in the pane's conversation, while it runs; undefined for a row that names none or one over. */
export const useNoticeWait = (): ((row: ChatMessage) => PendingWait | undefined) => {
    const { conversation } = usePaneView();
    const { agentById } = useAgents();
    return (row) => {
        switch (row.noticeWait) {
            case `credentialRenewal`:
                return clock(conversation.value.failures.credentialRenewal.value?.since, `up`);
            case `chatRoute`:
                return clock(chatRouteWait(conversation.value)?.since, `up`);
            case `watch`: {
                const id = row.noticeWaitId;
                const armed = id === undefined ? undefined : agentById(conversation.value.conversationId)?.watches?.find((watch) => watch.id === id);
                return clock(armed?.deadlineAt, `down`);
            }
            default:
                return undefined;
        }
    };
};
