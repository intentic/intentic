import { sleep } from "@intentic/base/async";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { ROSTER } from "../../../conversations/actor/subagent-roster.js";
import { backgroundJobOf } from "../../tools/jobs/background-jobs.js";
import { pairLiveSubagents, type SubagentRecord } from "../subagents.js";
import { TASKS } from "../subagent-tasks.js";

/* A WAIT ON AN AGENT ID HANDED BACK MOMENTS AGO (2026-11-17, the shinobi-society audit). Claude Code's Agent tool answers
   with the child's agentId, and the roster knows an in-process child by its tool call's id until its meta file is read
   (pairLiveSubagents), which nothing did before a wait: `wait` on the agentId of a child launched a second earlier came
   back `unknown-target` at once, and the parent fell back to polling. A wait now resolves the name it was given the ways
   the runtime may have handed it out (the record's own id, its agentId, the CLI's task id), reads the meta files if none
   matches yet, and gives a child whose start the stream has not delivered yet a few seconds to appear. */

// A call naming neither `target` nor `targets` waits on nothing; saying which to name beats guessing "any".
export const NO_TARGET =
    'Name what to wait on: `target` (a subagent\'s id, a background command\'s ID, "any" or "all"), or `targets` for several children as one.';

// How long a name that matches nothing yet is given, and how often it is looked for meanwhile.
const APPEAR_MS = 5_000;
const LOOK_MS = 250;

type Actors = Pick<ConversationActors, "holdings">;

/** The conversation's child the name stands for: its record's id, its agentId, or the task id the CLI gave it. */
export const childNamed = (actors: Actors, conversationId: string, name: string): SubagentRecord | undefined => {
    const roster = actors.holdings(ROSTER);
    const direct = roster.of(conversationId).find((record) => record.id === name || record.agentId === name);
    if (direct !== undefined) {
        return direct;
    }
    const byTask = actors.holdings(TASKS).get(name);
    const record = byTask === undefined ? undefined : roster.get(byTask);
    return record?.conversationId === conversationId ? record : undefined;
};

/**
 * The id to wait on for `name`: the child's own record id once it is found, else `name` as given (a background command's
 * id, "any", or a name that matched nothing within the grace, which the wait then answers as unknown).
 */
const targetNamed = async (actors: Actors, conversationId: string, name: string, signal?: AbortSignal, appearMs = APPEAR_MS): Promise<string> => {
    if (name === "any" || name === "all" || backgroundJobOf(actors, conversationId, name) !== undefined) {
        return name;
    }
    const deadline = Date.now() + appearMs;
    for (;;) {
        const found = childNamed(actors, conversationId, name);
        if (found !== undefined) {
            return found.id;
        }
        // allow(silent-catch): an unreadable meta dir pairs nothing this look; the next look reads it again.
        await pairLiveSubagents(actors).catch(() => undefined);
        const paired = childNamed(actors, conversationId, name);
        if (paired !== undefined) {
            return paired.id;
        }
        if (Date.now() >= deadline || signal?.aborted === true) {
            return name;
        }
        await sleep(LOOK_MS);
    }
};

/** `targetNamed` for a call's `target`, which may name nothing. */
export const waitTargetOf = async (actors: Actors, conversationId: string, name: string | undefined, signal?: AbortSignal, appearMs?: number): Promise<string | undefined> =>
    name === undefined ? undefined : targetNamed(actors, conversationId, name, signal, appearMs);

/** `targetNamed` over a call's `targets`, looked for together; undefined stays undefined ("all"). */
export const waitTargetsOf = async (actors: Actors, conversationId: string, names: readonly string[] | undefined, signal?: AbortSignal): Promise<readonly string[] | undefined> =>
    names === undefined ? undefined : Promise.all(names.map((name) => targetNamed(actors, conversationId, name, signal)));
