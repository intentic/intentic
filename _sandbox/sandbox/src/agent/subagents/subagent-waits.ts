import { randomUUID } from "node:crypto";
import type { SubagentSession, SubagentStatus } from "@intentic/sandbox-contract/schemas/terminal";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import { ROSTER, subagentRunning } from "../../conversations/actor/subagent-roster.js";
import { type SubagentRecord, WAITERS, wire } from "./subagents.js";

// Where a conversation's children and the waits on them are held: each conversation's actor.
type Actors = Pick<ConversationActors, "holdings">;

/* A WAIT ON SEVERAL CHILDREN AT ONCE. A parent with seven children waited on "any" and was woken once per child, each
   wake a model call on a context of 300K tokens and more (2026-10-17). Named together (or every live child with
   "all"), they are waited on as one: the wait comes back early only for trouble, a child blocked on a question, paused
   for a re-run, failed or stopped, and otherwise once every one of them has finished, with all their endings at once. */

export interface SubagentsWaitOptions {
    // The children's ids; undefined is every child of the conversation still live when the wait starts.
    readonly targets?: readonly string[];
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
}

export interface SubagentsWaitOutcome {
    // `blocked` and `failed` come back early with the child that moved; `finished` once all have; `unknown-target` when
    // none of the named is this conversation's, or none is live for "all".
    readonly outcome: "finished" | "blocked" | "failed" | "timeout" | "aborted" | "unknown-target";
    // The child that brought the wait back early.
    readonly matched?: SubagentSession;
    // Every child waited on, as it stands when the wait answers.
    readonly agents: readonly SubagentSession[];
}

// What brings a wait on several back before they have all finished.
const TROUBLE: ReadonlySet<SubagentStatus> = new Set(["blocked", "paused", "failed", "killed"]);

export const waitForSubagents = (actors: Actors, conversationId: string, options: SubagentsWaitOptions): Promise<SubagentsWaitOutcome> =>
    new Promise((resolve) => {
        const records = actors.holdings(ROSTER);
        const waiters = actors.holdings(WAITERS);
        const waiter = randomUUID();
        // Fixed at the start: "all" is the children live now, not ones spawned while the wait is parked.
        const ids =
            options.targets ??
            records
                .of(conversationId)
                .filter(subagentRunning)
                .map((record) => record.id);
        const watched = (): SubagentRecord[] => records.of(conversationId).filter((record) => ids.includes(record.id));
        // oxlint-disable-next-line prefer-const -- A later branch assigns and clears this binding.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (result: SubagentsWaitOutcome): void => {
            waiters.drop(waiter);
            options.signal?.removeEventListener("abort", onAbort);
            if (timer !== undefined) {
                clearTimeout(timer);
            }
            resolve(result);
        };
        const onAbort = (): void => settle({ outcome: "aborted", agents: watched().map(wire) });
        const evaluate = (): void => {
            const found = watched();
            if (found.length === 0) {
                settle({ outcome: "unknown-target", agents: [] });
                return;
            }
            // Trouble not yet handed over brings it back at once; one already reported does not bring it back again.
            const trouble = found.find((record) => TROUBLE.has(record.status) && record.reported !== record.status);
            if (trouble !== undefined) {
                trouble.reported = trouble.status;
                settle({
                    outcome: trouble.status === "blocked" || trouble.status === "paused" ? "blocked" : "failed",
                    matched: wire(trouble),
                    agents: found.map(wire),
                });
                return;
            }
            if (found.every((record) => !subagentRunning(record) || record.status === "paused")) {
                for (const record of found) {
                    record.reported = record.status;
                }
                settle({ outcome: "finished", agents: found.map(wire) });
            }
        };
        if (options.signal?.aborted === true) {
            resolve({ outcome: "aborted", agents: watched().map(wire) });
            return;
        }
        options.signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => settle({ outcome: "timeout", agents: watched().map(wire) }), options.timeoutMs);
        timer.unref();
        waiters.hold(conversationId, waiter, evaluate);
        evaluate();
    });

/** Every parent parked in a wait right now, with its children on `provider` that failed or are paused for a re-run. */
export const parentsWaitingOn = (actors: Actors, provider: string): readonly { readonly parent: string; readonly children: readonly string[] }[] => {
    const waiters = actors.holdings(WAITERS);
    const parents = new Set(waiters.entries().flatMap(([id]) => waiters.holder(id) ?? []));
    return [...parents].flatMap((parent) => {
        const children = actors
            .holdings(ROSTER)
            .of(parent)
            .filter((record) => record.provider === provider && (record.status === "failed" || record.status === "paused"))
            .map((record) => record.id);
        return children.length === 0 ? [] : [{ parent, children }];
    });
};
