import { holdsRequest } from "@intentic/sandbox-contract/events/transcript";
import type { AgentJob } from "@intentic/sandbox-contract/schemas/agents";
import type { ChatMessage, ChatTurn } from "../../../../models/conversations/transcript/transcript";
import { jobPhase } from "../jobPhase";

// A STEP GROUP: rows that, with tool calls hidden, would each fold to a band of their own, standing as ONE band. A
// background job's start splits the agent's row, so a run of steps used to read job, calls, job, calls: four bands
// stacked in one seam, each opened on its own. Grouped, they are one band and one press, and the row with words they
// led to (the tail) hands its own leading calls to that band too, so the seam above its words is never two bands.

export interface StepGroup {
    // The first member's id: what the group is keyed by, and the row that draws it.
    readonly head: number;
    // Rows drawn only inside the group, in transcript order: background job starts and rows holding only calls or a thought.
    readonly members: readonly ChatMessage[];
    // A row with words right after the members, whose own calls and thought the group's band stands for.
    readonly tail?: ChatMessage;
}

export interface StepGroups {
    readonly heads: ReadonlyMap<number, StepGroup>;
    // Members other than the head: drawn inside the head's group, never as rows of their own.
    readonly folded: ReadonlySet<number>;
    // A tail's id to its group.
    readonly tails: ReadonlyMap<number, StepGroup>;
}

const hasRun = (message: ChatMessage): boolean => (message.tools?.length ?? 0) > 0 || (message.thinking ?? ``) !== ``;

// A job start with no context of its own to show.
const isJob = (message: ChatMessage): boolean => message.role === `notice` && message.backgroundJob !== undefined && !message.notes?.length;

// An agent row that draws nothing but its run: no words, checklist, card, page, review or note beside it.
const isRunOnly = (message: ChatMessage): boolean =>
    message.role === `assistant` &&
    hasRun(message) &&
    message.text === `` &&
    !message.todos?.length &&
    !message.notes?.length &&
    !message.placed &&
    message.page === undefined &&
    message.review === undefined &&
    !holdsRequest(message);

// Group by transcript adjacency, never by completion time. Live state changes the disclosure, not its identity, so
// inspecting a command survives the last job finishing. Each turn and each edit/fork boundary starts a new group. The
// row still being written (`live`) is never a member or a tail: what it turns out to be is not known yet, and its band
// is the one that shows the turn working.
export const stepGroupsOf = (
    turns: readonly ChatTurn[],
    cuts: ReadonlyMap<number, number>,
    doomed: ReadonlySet<number>,
    live?: number,
): StepGroups => {
    const heads = new Map<number, StepGroup>();
    const folded = new Set<number>();
    const tails = new Map<number, StepGroup>();
    for (const turn of turns) {
        let run: ChatMessage[] = [];
        const flush = (tail?: ChatMessage): void => {
            // Two bands at least, or there is nothing to merge.
            if (run.length > 1 || (run.length === 1 && tail !== undefined)) {
                const group: StepGroup = tail === undefined ? { head: run[0]!.id, members: run } : { head: run[0]!.id, members: run, tail };
                heads.set(group.head, group);
                for (const message of run.slice(1)) {
                    folded.add(message.id);
                }
                if (tail !== undefined) {
                    tails.set(tail.id, group);
                }
            }
            run = [];
        };
        for (const message of turn.messages) {
            if (cuts.has(message.id) || (run.length > 0 && doomed.has(message.id) !== doomed.has(run[0]!.id))) {
                flush();
            }
            if (message.id !== live && (isJob(message) || isRunOnly(message))) {
                run.push(message);
            } else {
                flush(message.id !== live && message.role === `assistant` && hasRun(message) && !message.notes?.length ? message : undefined);
            }
        }
        flush();
    }
    return { heads, folded, tails };
};

// Whether a group stands as its band: tool calls hidden, and none of its jobs still running, since a running job is
// news and its row says so. Until then each member draws as it would alone.
export const stepsFold = (group: StepGroup, live: readonly AgentJob[] | undefined, showToolCalls: boolean): boolean =>
    !showToolCalls &&
    group.members.every((member) => {
        const job = member.backgroundJob;
        return job === undefined || jobPhase(live?.find((entry) => entry.id === job.id)).kind !== `running`;
    });

// How a row's own run draws when a group's band stands for it: not at all while the band is shut; opened, inline with
// no control of its own. `last` is the group's final run, which carries the press that keeps every run open.
export type MergedSteps = `shut` | `open` | `open-last`;
