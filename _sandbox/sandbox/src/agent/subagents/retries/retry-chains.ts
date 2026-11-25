import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { ROSTER } from "../../../conversations/actor/subagent-roster.js";
import { opt } from "../../../opt.js";
import { CHILDREN } from "../child-records.js";
import { taskLine } from "../child-spec.js";
import type { ChildRecord, ChildSpawnSpec } from "../children.js";

/* A RETRY CHAIN, AND WHERE IT STOPS (2026-11-24). A parent whose child failed spawned the same task again, and again,
   each time on its own judgement, and nothing on the record said the new child replaced the old one: a notice that
   capacity was back matched children by their task line instead (capacity-reopened.ts). A spawn may now name the failed
   child it retries (`retryOf`): the new child carries the chain's task id, the id of the chain's first child, kept on
   its file with its spec, so the link survives a restart. A chain whose last three children each failed is broken: a
   further retry in it is refused, in words that tell the parent to stop and report rather than try again, and a spawn
   that leaves `retryOf` out but reads as that same task is started with a warning saying so. A child cancelled by its
   parent neither counts as a failure nor clears the streak; one that completed, or still runs, clears it. Orca's
   coordinator stops a task's retries the same way (coordinator/escalation/coordinator-escalation-triage.ts). */

/** How many failures in a row break a chain. */
export const CHAIN_FAILURES_MOST = 3;

// Where the records and their roster rows are held.
type Actors = Pick<ConversationActors, "holdings">;

/** The chain a child belongs to: its spawn's task id, or its own id for a chain's first child. */
export const chainOf = (id: string, kid: Pick<ChildRecord, "spec">): string => kid.spec.taskId ?? id;

interface Member {
    readonly id: string;
    readonly kid: ChildRecord;
}

// One parent's children in a chain, most recently started first.
const membersOf = (actors: Actors, parent: string, task: string): readonly Member[] =>
    actors
        .holdings(CHILDREN)
        .entries()
        .filter(([id, kid]) => kid.parent === parent && chainOf(id, kid) === task)
        .map(([id, kid]) => ({ id, kid }))
        .toSorted((left, right) => right.kid.startedAt - left.kid.startedAt);

// The failures that end a chain, latest first: each failed child until one that completed or is still under way.
const failedStreak = (actors: Actors, members: readonly Member[]): readonly Member[] => {
    const failed: Member[] = [];
    for (const member of members) {
        const status = actors.holdings(ROSTER).get(member.id)?.status;
        if (status === "killed") {
            continue;
        }
        if (status !== "failed") {
            break;
        }
        failed.push(member);
    }
    return failed;
};

const failureWords = (actors: Actors, failed: readonly Member[]): string =>
    failed
        .toReversed()
        .map((member) => {
            const error = actors.holdings(ROSTER).get(member.id)?.error;
            return error === undefined ? `\`${member.id}\`` : `\`${member.id}\` (${error.replaceAll(/\s+/gu, " ").trim().slice(0, 160)})`;
        })
        .join(", ");

const brokenWords = (actors: Actors, failed: readonly Member[]): string =>
    `This task has failed ${failed.length} times in a row: ${failureWords(actors, failed)}. So this retry was refused and nothing was started. ` +
    "Stop retrying it: report what failed and why, with the errors above, to whoever you work for, and let them decide what comes next.";

/** Whether a chain is broken: its failures in a row, latest first, where they reach CHAIN_FAILURES_MOST. */
export const brokenChain = (actors: Actors, parent: string, task: string): readonly string[] | undefined => {
    const failed = failedStreak(actors, membersOf(actors, parent, task));
    return failed.length >= CHAIN_FAILURES_MOST ? failed.map((member) => member.id) : undefined;
};

/** What a spawn becomes once its retry link is read: the spec it starts with and a note for its parent, or a refusal. */
export type RetryLink = { readonly spec: ChildSpawnSpec; readonly note?: string } | { readonly refused: string };

// A spawn naming no retry that reads as a broken chain's task: started, with a warning.
const lookalike = (actors: Actors, parent: string, spec: ChildSpawnSpec): string | undefined => {
    const line = taskLine(spec);
    const chains = new Set(
        actors
            .holdings(CHILDREN)
            .entries()
            .filter(([, kid]) => kid.parent === parent && taskLine(kid.spec) === line)
            .map(([id, kid]) => chainOf(id, kid)),
    );
    for (const task of chains) {
        const failed = failedStreak(actors, membersOf(actors, parent, task));
        if (failed.length >= CHAIN_FAILURES_MOST) {
            return (
                `Warning: this task reads like one that has already failed ${failed.length} times in a row (${failureWords(actors, failed)}), ` +
                "which a retry would be refused for. If it is that task again, cancel this child and report what failed instead of retrying it."
            );
        }
    }
    return undefined;
};

/**
 * A spawn's place in a retry chain. Naming `retryOf`, it must name a settled child of this parent, and joins that child's
 * chain unless the chain is broken; naming none, it starts a chain of its own, warned when it reads as a broken one.
 */
export const retryLink = (actors: Actors, parent: string, spec: ChildSpawnSpec): RetryLink => {
    // A task id is the sandbox's to set, never the caller's.
    const { taskId: _asked, retryOf, ...rest } = spec;
    if (retryOf === undefined) {
        return { spec: rest, ...opt("note", lookalike(actors, parent, rest)) };
    }
    const retried = actors.holdings(CHILDREN).get(retryOf);
    if (retried === undefined || retried.parent !== parent) {
        return { refused: `\`retryOf\` names \`${retryOf}\`, which is no subagent of yours on record, so nothing was started. Name the failed child this spawn replaces, or leave it out.` };
    }
    const status = actors.holdings(ROSTER).get(retryOf)?.status;
    if (status !== "failed" && status !== "completed" && status !== "killed") {
        return {
            refused: `\`${retryOf}\` is still ${status ?? "starting"}, so a retry of it was refused and nothing was started. Wait for it, or cancel it first if you mean to replace it.`,
        };
    }
    const task = chainOf(retryOf, retried);
    const members = membersOf(actors, parent, task);
    const failed = failedStreak(actors, members);
    if (failed.length >= CHAIN_FAILURES_MOST) {
        return { refused: brokenWords(actors, failed) };
    }
    const tried = members.length + 1;
    return {
        spec: { ...rest, retryOf, taskId: task },
        note: `It retries \`${retryOf}\`: try ${tried} of the task \`${task}\` began, which is refused further retries once ${CHAIN_FAILURES_MOST} in a row have failed.`,
    };
};
