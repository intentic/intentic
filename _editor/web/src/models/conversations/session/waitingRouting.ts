import { loopOf } from "@intentic/sandbox-contract/models/agent-catalog";
import type { ConversationQueue, QueuedMessage, QueuedServing } from "@intentic/sandbox-contract/schemas/agent";
import type { ResumeRouting } from "@intentic/sandbox-contract/schemas/providers/plan-limits";

/* WHERE A PERSON'S WAITING WORDS GO, AGAINST THE COMPOSER'S PICK. Words held or booked in the queue go out by themselves
   on the pick they were sent under (each carries its own request), so a pick in the model picker changed what the
   composer said and nothing about them: a message booked on Claude went on Claude after the reader had moved the chat to
   Codex, under a divider promising Codex (2026-10-20). The sandbox now says who serves each one (`serves`), a pick moves
   them with it (agent.queueReroute, ComposerSelection), and the held line says where they go whenever that is still
   somewhere else. Pure: the queue and the pick are handed in. */

// Which part of a pick the words differ on, in the order a reader names a model: the runtime first, then the model on
// it, then the account that pays. Effort is left out: it moves with a pick, but is not worth a line of its own.
export type ServedApart = `runtime` | `model` | `account`;

/**
 * What words served so go on apart from `routing`, or undefined where they go there: another provider or loop, another
 * model, or another account where the pick names one. What the pick leaves unnamed (a model before the catalog loads,
 * the daemon's own account) is no difference.
 */
export const servedApart = (serves: QueuedServing, routing: ResumeRouting): ServedApart | undefined => {
    if (serves.agent !== routing.agent || loopOf(serves.agent, serves.harness) !== loopOf(routing.agent, routing.harness)) {
        return `runtime`;
    }
    if (routing.model !== undefined && serves.model !== routing.model) {
        return `model`;
    }
    return routing.account !== undefined && serves.account !== routing.account ? `account` : undefined;
};

// Whether words served so would be moved by a pick: any difference above, or the effort it names.
const movedBy = (serves: QueuedServing, routing: ResumeRouting): boolean =>
    servedApart(serves, routing) !== undefined || (routing.effort !== undefined && serves.effort !== routing.effort);

/**
 * The person's waiting words a pick would move, among `ids` when named: those served anywhere else. None from a sandbox
 * older than `serves`, which says nothing about where they go.
 */
export const movedByPick = (queue: ConversationQueue | undefined, routing: ResumeRouting, ids?: readonly string[]): readonly QueuedMessage[] =>
    (queue?.items ?? []).filter((item) => item.serves !== undefined && (ids === undefined || ids.includes(item.id)) && movedBy(item.serves, routing));
