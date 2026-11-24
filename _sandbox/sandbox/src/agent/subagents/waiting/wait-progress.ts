import { briefDuration, plural, sizeLabel } from "@intentic/base/format";
import { oneLine } from "@intentic/base/one-line";
import type { SubagentSession } from "@intentic/sandbox-contract/schemas/terminal";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { type Holding, turnRunOf } from "../../../conversations/actor/conversation-holdings.js";
import { ROSTER, subagentRunning } from "../../../conversations/actor/subagent-roster.js";
import { type BackgroundJob, jobOutputPath, runningJobsOf } from "../../tools/jobs/background-jobs.js";
import { jobReport } from "../../tools/jobs/job-report.js";
import { type OutputMark, readOutputOn, shownLine } from "./output-lines.js";
import { childEditedPaths } from "../child-verification.js";
import { type LaneReader, laneReaderOf, quietLaneChildWords, quietLaneNow } from "../quiet-lane-words.js";
import type { QuietLane } from "../../../system/resources/queue/quiet-lane.js";

/* WHAT A WAIT THAT RAN OUT SAYS (2026-11-19, the shinobi-society audit). Parents hit `wait`'s 1800 s cap 66 times, each a
   model step over 120k-450k tokens of context, and read their children with `agents show` between waits (21 times in one
   parent, 17 in another); children read their own commands' logs with `tail` and `cat` 164 times. A wait that times out
   now says, for each thing it waited on, what moved since the last answer about it: a command's new lines and bytes, its
   last lines and its silence; a child's tool calls since, its last words, what holds it, and the files it changed so
   far. A few lines each, so waiting again is the whole next step. */

// What the last answer about one waited thing had seen, so the next says what came since: by `job:<id>` or `child:<id>`,
// held by the conversation that waits, and gone with it.
interface Look {
    // How far the last answer read a command's output; and just past the line a pattern last matched, where the next
    // pattern wait reads on from (a timeout moves only the first, so a line it did not show can still match).
    readonly output?: OutputMark;
    readonly matched?: OutputMark;
    readonly toolUses?: number;
}
const LOOKS: Holding<Look> = { name: "wait looks" };

type Actors = Pick<ConversationActors, "holdings">;

// A child as a progress line reads it: its roster record, or that record as a wait handed it over.
type ChildSeen = Pick<SubagentSession, "id" | "conversationId" | "status" | "startedAt" | "description" | "toolUses" | "lastTool" | "summary" | "error" | "kind">;

// Targets past this many are counted, not described: a wait on "any" in a wide fan-out.
const DESCRIBED = 12;
// How much of a child's last words and of its changed files a line names.
const SAID_CHARS = 160;
const FILES_NAMED = 3;

const jobKey = (job: BackgroundJob): string => `job:${job.id}`;
const childKey = (id: string): string => `child:${id}`;

// How far the last answer about this command read its output.
const outputLookOf = (actors: Actors, job: BackgroundJob): OutputMark | undefined => actors.holdings(LOOKS).get(jobKey(job))?.output;

const noteOutputLook = (actors: Actors, job: BackgroundJob, mark: OutputMark): void => {
    const looks = actors.holdings(LOOKS);
    looks.hold(job.conversationId, jobKey(job), { ...looks.get(jobKey(job)), output: mark });
};

/** Just past the line a pattern last matched in this command's output, where the next pattern wait reads on from. */
export const matchMarkOf = (actors: Actors, job: BackgroundJob): OutputMark | undefined => actors.holdings(LOOKS).get(jobKey(job))?.matched;

/** Files a match handed over: the next pattern wait, and the next timeout's count, start just past its line. */
export const noteMatchMark = (actors: Actors, job: BackgroundJob, mark: OutputMark): void => {
    const looks = actors.holdings(LOOKS);
    looks.hold(job.conversationId, jobKey(job), { ...looks.get(jobKey(job)), output: mark, matched: mark });
};

/** Files the tool calls a child had made when an answer about it was handed over. */
export const noteChildLook = (actors: Actors, child: Pick<SubagentSession, "id" | "conversationId" | "toolUses">): void => {
    const looks = actors.holdings(LOOKS);
    looks.hold(child.conversationId, childKey(child.id), { ...looks.get(childKey(child.id)), toolUses: child.toolUses ?? 0 });
};

const age = (ms: number): string => briefDuration(Math.max(0, Math.round(ms / 1000)));

/** A command's progress since the last answer about it, in a few lines; files this as the new last look. */
const jobProgress = async (actors: Actors, job: BackgroundJob, now: number = Date.now()): Promise<string> => {
    const report = await jobReport(actors, job, now);
    const source = report.outputTailFrom ?? jobOutputPath(job);
    const before = outputLookOf(actors, job);
    const looked = before?.path === source;
    const read = readOutputOn(job.dir, looked ? before : { path: source, offset: 0, lines: 0 }, { final: !report.running });
    noteOutputLook(actors, job, read.mark);
    const since = looked ? "since your last look" : "so far";
    const state = report.running
        ? `running ${age(now - job.startedAt)}${report.quietForSeconds === undefined ? "" : `, quiet ${briefDuration(report.quietForSeconds)}`}`
        : `exited ${report.exitCode ?? "without a code"}`;
    const moved = read.bytes === 0 ? `nothing new ${since}` : `${read.skipped > 0 ? "over " : ""}${plural(read.lines, "new line")} (${sizeLabel(read.bytes)}) ${since}`;
    const prompt = report.waitingForInput === undefined ? "" : `; sitting at a prompt (${report.waitingForInput.program}) nothing will type into`;
    const head = `command ${report.id} (${report.command}): ${state}; ${moved}${report.outputTailFrom === undefined ? "" : ` in ${source}`}${prompt}`;
    const shown = [...read.last.map(shownLine), ...(read.unfinished === undefined ? [] : [read.unfinished])].map((line) => `  ${line}`);
    return shown.length === 0 ? head : [`${head}, ending:`, ...shown].join("\n");
};

// The last line of a child's last words: its own conversation's latest reply, else the progress line its runtime keeps.
const lastSaid = (actors: Actors, child: ChildSeen): string | undefined => {
    const reply = turnRunOf(actors, child.id)?.rows.findLast((row) => row.role === "assistant" && row.text.trim() !== "")?.text;
    const line = (reply ?? (child.kind === "subagent" ? child.summary : undefined))
        ?.split("\n")
        .map((part) => part.trim())
        .findLast((part) => part !== "");
    return line === undefined ? undefined : oneLine(line, SAID_CHARS);
};

// What a child that is not working waits on, in its own row's words: held for room or a seat, a question, a pause.
const waitsOn = (child: ChildSeen): string | undefined => {
    const why = oneLine((child.status === "paused" ? child.error : undefined) ?? child.summary ?? "", SAID_CHARS);
    if (child.status === "running" || why === "") {
        return undefined;
    }
    return child.status === "pending" ? `held: ${why}` : why;
};

const filesWords = (paths: readonly string[]): string | undefined => {
    if (paths.length === 0) {
        return undefined;
    }
    const named = paths.slice(-FILES_NAMED).join(", ");
    return `${plural(paths.length, "file")} changed (${paths.length > FILES_NAMED ? `… ${named}` : named})`;
};

// The quiet lane as this answer read it, for a child whose own command waits in it (quiet-lane-words.ts).
interface LaneSeen {
    readonly lane: QuietLane | undefined;
    readonly reader: LaneReader;
}

/** A child's progress since the last answer about it, in a line; files this as the new last look. */
const childProgress = (actors: Actors, child: ChildSeen, seen: LaneSeen | undefined, now: number = Date.now()): string => {
    const before = actors.holdings(LOOKS).get(childKey(child.id))?.toolUses;
    noteChildLook(actors, child);
    const calls = child.toolUses ?? 0;
    const said = subagentRunning(child) ? lastSaid(actors, child) : undefined;
    const parts = [
        `${child.status} ${age(now - child.startedAt)}`,
        waitsOn(child),
        seen === undefined || child.kind !== "spawned" ? undefined : quietLaneChildWords(seen.lane, child.id, seen.reader),
        `${plural(calls, "tool call")}${before === undefined ? "" : ` (${Math.max(0, calls - before)} since your last look)`}${child.lastTool === undefined ? "" : `, last ${child.lastTool}`}`,
        filesWords(childEditedPaths(actors, child.id)),
        said === undefined ? undefined : `last said: "${said}"`,
    ];
    const description = child.description === undefined ? "" : ` ("${oneLine(child.description, 80)}")`;
    return `${child.kind === "subagent" ? "subagent" : "child"} ${child.id}${description}: ${parts.filter((part) => part !== undefined).join(" · ")}`;
};

/** What a wait was parked on, as its progress names it. */
export interface WaitedOn {
    readonly jobs: readonly BackgroundJob[];
    readonly children: readonly string[];
}

/** Everything a wait on "any" covers: the children still live and, where it waited on them, the commands still running. */
export const anyWaitedOn = (actors: Actors, conversationId: string, commands: boolean): WaitedOn => ({
    jobs: commands ? runningJobsOf(actors, conversationId) : [],
    children: actors
        .holdings(ROSTER)
        .of(conversationId)
        .filter(subagentRunning)
        .map((record) => record.id),
});

/** One entry per thing the wait was parked on, saying what moved since the last answer about it. */
export const progressOf = async (actors: Actors, conversationId: string, waited: WaitedOn, now: number = Date.now()): Promise<readonly string[]> => {
    // By the record's own id or the agentId the runtime handed out, as a wait on several may name it.
    const own = actors.holdings(ROSTER).of(conversationId);
    const children = waited.children.flatMap((id) => own.find((record) => record.id === id || record.agentId === id) ?? []);
    const jobs = waited.jobs.slice(0, DESCRIBED);
    const described = children.slice(0, Math.max(0, DESCRIBED - jobs.length));
    // Read once for every child described, and only when one is a spawned child still at work: what its commands wait on.
    const seen = described.some((child) => child.kind === "spawned" && subagentRunning(child))
        ? { lane: await quietLaneNow(), reader: laneReaderOf(actors, conversationId) }
        : undefined;
    const said = [...(await Promise.all(jobs.map((job) => jobProgress(actors, job, now)))), ...described.map((child) => childProgress(actors, child, seen, now))];
    const left = waited.jobs.length + children.length - said.length;
    return left > 0 ? [...said, `… and ${String(left)} more`] : said;
};
