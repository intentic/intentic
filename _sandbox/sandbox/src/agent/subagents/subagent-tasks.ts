import type { SubagentStatus } from "@intentic/sandbox-contract/schemas/terminal";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import type { Holding } from "../../conversations/actor/conversation-holdings.js";
import { ROSTER, subagentRunning } from "../../conversations/actor/subagent-roster.js";
import type { SubagentRecord } from "./subagents.js";

// The SDK's task_* messages as the roster reads them (subagents.ts noteSubagentTask folds them): their fields, which of
// them are agents, their status words, and which record each names.

// The fields the daemon reads off the SDK's four task_* message shapes.
export interface SubagentTaskMessage {
    readonly subtype: string;
    readonly task_id?: string;
    readonly tool_use_id?: string;
    readonly description?: string;
    // The CLI's raw discriminant; an open string since the SDK adds values to it without notice.
    readonly task_type?: string;
    readonly subagent_type?: string;
    readonly prompt?: string;
    readonly skip_transcript?: boolean;
    readonly status?: string;
    readonly summary?: string;
    readonly last_tool_name?: string;
    readonly usage?: { readonly total_tokens?: number; readonly tool_uses?: number; readonly duration_ms?: number };
    readonly patch?: { readonly status?: string; readonly end_time?: number; readonly error?: string; readonly is_backgrounded?: boolean };
}

// A task id, or a call that resumed a task, to the record it is about, held by the turn's conversation; only task_started
// carries both a task id and a call.
export const TASKS: Holding<string> = { name: "subagent tasks" };

// True only when `subagent_type` is set or `task_type` is `local_agent`, deliberately a whitelist so an unknown future
// type is left off. Adopted later anyway via SubagentStop's meta file if unlabelled.
export const isSubagentTask = (message: SubagentTaskMessage): boolean => message.subagent_type !== undefined || message.task_type === "local_agent";

// SubagentStatusSchema's own vocabulary; an SDK status we don't recognize leaves the record's status unchanged.
const OWN_STATUSES: readonly SubagentStatus[] = ["pending", "running", "completed", "failed", "killed", "paused"];
const STATUSES = new Map<string, SubagentStatus>(OWN_STATUSES.map((status) => [status, status]));
export const statusOf = (value: string | undefined): SubagentStatus | undefined => (value === undefined ? undefined : STATUSES.get(value));

// Maps task_notification's own status words, not the task vocabulary, to ours; 'stopped' becomes `killed`.
const NOTIFIED = new Map<string, SubagentStatus>([
    ["completed", "completed"],
    ["failed", "failed"],
    ["stopped", "killed"],
]);
export const notifiedStatus = (word: string | undefined): SubagentStatus | undefined => (word === undefined ? undefined : NOTIFIED.get(word));

type Actors = Pick<ConversationActors, "holdings">;

/** The record a task message is about: its call's own, else the one that call resumed, else the one its task opened. */
export const taskRecordOf = (actors: Actors, message: Pick<SubagentTaskMessage, "tool_use_id" | "task_id">): string | undefined => {
    const call = message.tool_use_id;
    if (call !== undefined && actors.holdings(ROSTER).has(call)) {
        return call;
    }
    const tasks = actors.holdings(TASKS);
    return (call === undefined ? undefined : tasks.get(call)) ?? (message.task_id === undefined ? undefined : tasks.get(message.task_id));
};

/* A HELPER RESUMED WITH SendMessage IS THE SAME HELPER RUNNING AGAIN (2026-11-17, the shinobi-society audit). Claude Code
   continues a finished Agent-tool helper when its parent sends it a message, and announces the new run with another
   task_started under the same task id, the helper's agentId. Its tool_use_id is the SendMessage call's, or the original
   Agent call's off the helper's meta file when no call is resuming it (`toolUseId: r.toolUseId ?? … ?? meta.toolUseId`
   in the resume of Claude Code 0.3.325; jaguar-npc2 on 11-12 shows the first). The roster ignored the second shape (an
   id it already held) and opened a stranger under the first: `wait` on the agentId found the first run's settled record
   and answered at once with its old ending, `wait any` saw nothing running or a record the new report never reached
   (SubagentStop files it by the meta file's Agent call id, and the helper's own calls carry that id too), and the board
   grew a second row. A new run of a task the roster holds now reopens that record, its last ending and the mark that it
   was handed over cleared, and files the call that resumed it as another name for it. */

/**
 * The record a task_started is another run of, or undefined for a task the roster does not hold (which opens one of its
 * own): filed under the run's call too, and cleared of its last ending if it had one, ready to be moved to running.
 */
export const resumedRecord = (actors: Actors, conversationId: string, message: SubagentTaskMessage): SubagentRecord | undefined => {
    const id = taskRecordOf(actors, message);
    const record = id === undefined ? undefined : actors.holdings(ROSTER).get(id);
    if (record === undefined || record.conversationId !== conversationId) {
        return undefined;
    }
    if (message.tool_use_id !== undefined && message.tool_use_id !== record.id) {
        actors.holdings(TASKS).hold(conversationId, message.tool_use_id, record.id);
    }
    if (record.endedAt !== undefined || !subagentRunning(record)) {
        // Stamped afresh as this run ends (subagents.ts patch); the verification ledger stays, since this run carries
        // on the same work in the same checkout.
        record.endedAt = undefined;
        record.summary = undefined;
        record.summarySource = undefined;
        record.error = undefined;
        record.verification = undefined;
        record.reported = undefined;
        delete record.reportedAhead;
    }
    return record;
};
