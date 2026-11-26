import { briefDuration, plural } from "@intentic/base/format";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import { ROSTER } from "../../conversations/actor/subagent-roster.js";
import { type LaneRun, laneInUse, type QuietLane, readQuietLane } from "../../system/resources/queue/quiet-lane.js";

/* What a parent is told about the quiet lane (system/resources/queue/quiet-lane.ts): in a spawn's answer while the lane
   is in use, and in a wait's progress for a child whose own command waits in it or at its gate, where the child would
   otherwise look idle. Read when the answer is written, never on a timer. */

// Who a conversation is to the parent reading the line.
export interface LaneReader {
    readonly conversationId: string;
    // Its spawned children's conversation ids.
    readonly children: ReadonlySet<string>;
}

const whose = (conversation: string | undefined, reader: LaneReader): string => {
    if (conversation === undefined) {
        return "a command no conversation owns";
    }
    if (conversation === reader.conversationId) {
        return "you";
    }
    return reader.children.has(conversation) ? `your child \`${conversation}\`` : `\`${conversation}\``;
};

const held = (run: LaneRun): string => `${run.label === undefined ? "" : `\`${run.label}\`, `}${briefDuration(run.seconds)}`;

const waitVerb = (count: number): string => (count === 1 ? "waits" : "wait");

/** The spawn answer's line while the quiet lane is held or waited for; undefined while it is free. */
export const quietLaneSpawnWords = (lane: QuietLane | undefined, reader: LaneReader): string | undefined => {
    if (!laneInUse(lane)) {
        return undefined;
    }
    const count = lane.waiting.length;
    const mine = lane.waiting.filter((run) => run.conversation !== undefined && reader.children.has(run.conversation)).length;
    const yours = mine === 0 ? "" : mine === count ? `, ${count === 1 ? "from your own child" : "all from your own children"}` : `, ${String(mine)} of them from your own children`;
    const waiting = count === 0 ? "no run waits for it yet" : `${plural(count, "run")} ${waitVerb(count)} for it${yours}`;
    const before = lane.before === 0 ? "" : `, still waiting out ${plural(lane.before, "heavy command")} let in before it`;
    const holder = lane.holder === undefined ? "is between runs" : `is held by ${whose(lane.holder.conversation, reader)} (${held(lane.holder)}${before})`;
    const builds = lane.held.length === 0 ? "" : `; meanwhile ${plural(lane.held.length, "other heavy command")} ${waitVerb(lane.held.length)} at its gate`;
    return `The quiet lane (one timed run at a time, sandbox-wide) ${holder} and ${waiting}${builds}: children that time things will queue behind each other.`;
};

/** A wait progress part for a child whose own command holds the quiet lane, waits for it, or is held at its gate. */
export const quietLaneChildWords = (lane: QuietLane | undefined, child: string, reader: LaneReader): string | undefined => {
    if (lane === undefined) {
        return undefined;
    }
    const holder = lane.holder === undefined ? undefined : `${whose(lane.holder.conversation, reader)} (${held(lane.holder)})`;
    const parts: string[] = [];
    if (lane.holder?.conversation === child) {
        const before = lane.before === 0 ? "" : `, still waiting out ${plural(lane.before, "heavy command")} let in before it`;
        const behind = lane.waiting.length === 0 ? "" : `; ${plural(lane.waiting.length, "run")} ${waitVerb(lane.waiting.length)} behind it`;
        parts.push(`its command holds the quiet lane (${held(lane.holder)})${before}${behind}`);
    }
    const position = lane.waiting.findIndex((run) => run.conversation === child);
    if (position >= 0) {
        parts.push(`its timed run waits for the quiet lane${holder === undefined ? "" : `, held by ${holder}`}: position ${String(position + 1)} of ${String(lane.waiting.length)}`);
    }
    const builds = lane.held.filter((run) => run.conversation === child).length;
    if (builds > 0 && holder !== undefined) {
        parts.push(`${builds === 1 ? "a heavy command of its" : `${String(builds)} heavy commands of its`} ${waitVerb(builds)} at the gate until the quiet lane's run by ${holder} ends`);
    }
    return parts.length === 0 ? undefined : parts.join("; ");
};

/* A CONVERSATION'S OWN JOB IN THE LANE (2026-11-26, the shinobi-society audit). Four children each parked `wait` on their
   own `cargo test` job while their sibling's motion capture ran alone for 41 and then 25 minutes; queue-run said so on
   the command's stderr, which went into `> log 2>&1` or a `| tail`, and each wait's progress read "running 22m, nothing
   new". `own` is the job's processes (waiting/job-queue.ts), so these words speak of that job alone. */
/** A wait progress part for a job whose processes are `own`: running alone, waiting for its turn to, or held at the gate. */
export const quietLaneJobWords = (lane: QuietLane | undefined, own: ReadonlySet<number>, reader: LaneReader): string | undefined => {
    if (lane === undefined) {
        return undefined;
    }
    const holder = lane.holder === undefined ? undefined : `${whose(lane.holder.conversation, reader)} (${held(lane.holder)})`;
    if (lane.holder !== undefined && own.has(lane.holder.pid)) {
        const before = lane.before === 0 ? "" : `, still waiting out ${plural(lane.before, "heavy command")} let in before it`;
        const behind = [
            lane.waiting.length === 0 ? undefined : `${plural(lane.waiting.length, "run")} ${waitVerb(lane.waiting.length)} for its own turn`,
            lane.held.length === 0 ? undefined : `${plural(lane.held.length, "heavy command")} ${waitVerb(lane.held.length)} at the gate`,
        ].filter((part) => part !== undefined);
        return `it runs alone (${held(lane.holder)})${before}${behind.length === 0 ? "" : `, and until it ends ${behind.join(" and ")}`}`;
    }
    const position = lane.waiting.findIndex((run) => own.has(run.pid));
    const waiting = lane.waiting[position];
    if (waiting !== undefined) {
        return `waiting ${briefDuration(waiting.seconds)} for its turn to run alone, position ${String(position + 1)} of ${String(lane.waiting.length)}${holder === undefined ? "" : `; the lane is held by ${holder}`}`;
    }
    const gated = lane.held.find((run) => own.has(run.pid));
    if (gated !== undefined && holder !== undefined) {
        return `held ${briefDuration(gated.seconds)} at the gate: nothing heavy starts while the lane is held by ${holder}, which runs alone`;
    }
    return undefined;
};

/** The parent's spawned children, by conversation id: who "your child" is in these lines. */
export const laneReaderOf = (actors: Pick<ConversationActors, "holdings">, conversationId: string): LaneReader => ({
    conversationId,
    children: new Set(
        actors
            .holdings(ROSTER)
            .of(conversationId)
            .filter((record) => record.kind === "spawned")
            .map((record) => record.id),
    ),
});

/** The lane as it stands, or undefined where it could not be read: a spawn or a wait never fails over it. */
export const quietLaneNow = (): Promise<QuietLane | undefined> =>
    // allow(silent-catch): the lane line is advice beside a spawn or a wait; an unreadable /proc only leaves it out
    readQuietLane().catch(() => undefined);

/** A started child's spawn answer line about the quiet lane, read now. */
export const quietLaneSpawnNote = async (actors: Pick<ConversationActors, "holdings">, parent: string): Promise<string | undefined> =>
    quietLaneSpawnWords(await quietLaneNow(), laneReaderOf(actors, parent));
