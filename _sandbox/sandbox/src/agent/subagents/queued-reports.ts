import { randomUUID } from "node:crypto";
import { ROSTER } from "../../conversations/actor/subagent-roster.js";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import type { Holding } from "../../conversations/actor/conversation-holdings.js";

// A child's report that waits in its parent's queue (the parent was busy with a turn that takes no words): kept by the
// child it is about, so the wait that hands the same ending over first takes the queued copy back out, and the parent
// reads the ending once.

interface QueuedReport {
    readonly parent: string;
    // The id the report's words wait under in the parent's queue.
    readonly messageId: string;
}

// Held by the parent, about the child: either one's dispose takes it.
const QUEUED_REPORTS: Holding<QueuedReport> = { name: "queued child reports" };

// The queue is durable. Carry the child in its message id so withdrawing an ending needs no process-local index.
const reportPrefix = (child: string): string => `child-report-${encodeURIComponent(child)}:`;
export const queuedChildReportId = (child: string): string => `${reportPrefix(child)}${randomUUID()}`;

/** Files a child's report as waiting in its parent's queue under `messageId`. */
export const noteQueuedReport = (actors: Pick<ConversationActors, "holdings">, child: string, report: QueuedReport): void => {
    actors.holdings(QUEUED_REPORTS).hold(report.parent, child, report, child);
};

/**
 * Takes a child's report back out of its parent's queue, now that a wait handed the same ending over; one that already
 * left the queue (read, or changed since) is left alone. True when a queued copy was withdrawn.
 */
export const withdrawQueuedReport = (actors: Pick<ConversationActors, "holdings" | "queued" | "send">, child: string): boolean => {
    const held = actors.holdings(QUEUED_REPORTS);
    const report = held.get(child);
    held.drop(child);
    const parent = report?.parent ?? actors.holdings(ROSTER).get(child)?.conversationId;
    if (parent === undefined) {
        return false;
    }
    const item = actors.queued(parent).items.find((waiting) => waiting.id === report?.messageId || waiting.id.startsWith(reportPrefix(child)));
    if (item === undefined) {
        return false;
    }
    return actors.send(parent, { kind: "queue-removed", id: item.id, revision: item.revision }).reply === "done";
};
