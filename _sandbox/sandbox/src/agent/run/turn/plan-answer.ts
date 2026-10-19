import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { noticeCode } from "@intentic/sandbox-contract/events/sandbox-notice";
import { mentionPaths } from "@intentic/sandbox-contract/text/mentions";
import { userRow } from "@intentic/sandbox-contract/transcript-fold";

// A runtime's plan card need not name a conversation in the card registry. Its resolution belongs to the run that
// holds the pending card: record the answer there before a subsequent failure or transcript write can overtake it.
// Read before folding the resolution, so a repeated or unmatched answer cannot record the same words twice.
export const planAnswerRows = (rows: readonly TranscriptRow[], event: AgentEvent): readonly TranscriptRow[] => {
    if (event.kind !== "resolved" || event.reply?.kind !== "plan") {
        return [];
    }
    if (!rows.some((row) => row.plan?.requestId === event.requestId && row.plan.status === "pending")) {
        return [];
    }
    const answer = event.reply;
    const notes: TranscriptRow[] = [
        answer.approve
            ? { role: "notice", text: "Plan approved.", noticeCode: noticeCode({ code: "planApproved" }) }
            : { role: "notice", text: "Kept planning.", noticeCode: noticeCode({ code: "keptPlanning" }) },
    ];
    if (!answer.approve && answer.feedback !== undefined && answer.feedback.trim().length > 0) {
        notes.push(userRow(answer.feedback, Date.now(), mentionPaths(answer.feedback)));
    }
    return notes;
};
