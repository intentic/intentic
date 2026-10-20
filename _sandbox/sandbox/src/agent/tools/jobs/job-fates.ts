import type { TranscriptTool } from "@intentic/sandbox-contract/events/transcript";
import type { Logger } from "pino";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { type Holding, type LiveRun, turnRunOf } from "../../../conversations/actor/conversation-holdings.js";
import type { ListeningPort } from "../../../ports/port-scan.js";
import { cancelWatcher } from "../../verification/watchers.js";
import {
    type BackgroundJob,
    handedPorts,
    handJobOver,
    jobInputWait,
    jobPanes,
    type JobStopper,
    jobsToJudge,
    type JudgedJob,
    stopBackgroundJob,
    awaitedByRun,
} from "./background-jobs.js";

// What happens to what a turn leaves running, decided the moment it ends, from facts the sandbox holds and never from
// the turn's prose. A job goes one of three ways:
// - handed over, when the agent kept it for the person with the `keep` tool (keepBackgroundJob), or it listens on a port
//   this conversation already handed over (a restarted server): it keeps running, wakes nothing and holds no land, and
//   the person stops it (chat, Preview). The reply's words decide nothing: "I stopped the old server and started a fresh
//   one at http://localhost:5173" hands one over and "I stopped the server on localhost:5173" does not, and no reading
//   of either sentence told them apart;
// - stopped, when it listens on a port the turn reached itself, or one an earlier turn of the conversation reached (the
//   preview it restarted and did not open again), and nobody kept it: the instrument of the agent's own look, which the
//   sandbox reclaims rather than leave holding memory, the land and a six-hour watch. A call reaches it by what it was
//   given: its one-line target, or the input of a call that has none (Playwright code that goes to the page, a
//   delegation's prompt); on 2026-10-12 a turn that only ever reached its demo server through `browser_run_code_unsafe`
//   left it awaited, and the watch held a finished conversation's land;
// - stopped too, when it sits at a prompt (input-wait.ts: blocked reading its terminal, nothing moving) and nobody kept
//   it: no agent is left to answer it, and awaiting it armed a six-hour watch that held the land the whole time. On
//   2026-10-04 an `npx eslint` asking "Ok to proceed? (y)" did exactly that to a conversation whose work was done;
// - stopped too, when a turn that was cut off left it awaited (background-jobs.ts JobRecord.cut) and the next run that
//   ended cleanly never reached it: nobody chose to wait on it, and the run that carried the work on finished without
//   it. On 2026-10-20 a transcript scan outlived the re-run that finished its conversation's work by hours, holding a
//   six-hour wake that would have started a turn on a conversation already done. A run that did reach it (waited on it,
//   read its output) makes the wait its own, as if it had ended on it;
// - awaited, anything else: work whose exit the conversation waits on (background-adoption.ts), a listener the turn
//   never reached included (a test suite's own server mid-run), so a turn that ended to wait on its tests keeps them.

export interface JobFateDeps {
    readonly conversations: Pick<ConversationActors, "holdings" | "send">;
    // Every listener, each attributed to the pane it runs under (composition's scanPorts).
    readonly scanPorts: () => Promise<readonly ListeningPort[]>;
    readonly logger: Logger;
}

// The addresses a loopback server answers at, as the agent would type them.
const LOOPBACK = String.raw`(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])`;

// The agent reaching it: a URL or host:port naming the port.
const reachedAt = (port: number): RegExp => new RegExp(`${LOOPBACK}:${String(port)}(?!\\d)`, "u");

// Every loopback port a call's words name, as the agent would type them.
const NAMED_PORT = new RegExp(`${LOOPBACK}:(\\d{1,5})(?!\\d)`, "gu");
const portsNamed = (targets: readonly string[]): number[] => targets.flatMap((target) => [...target.matchAll(NAMED_PORT)].map((match) => Number(match[1])));

// What a call acted on, its helpers' calls included: its target, or for a call with none the input it was given;
// never what it printed, where a test suite's own log would name its server. The calls that started jobs are left out,
// so a command that starts a server and never reaches it is not read as reaching it.
const targetsOf = (tools: readonly TranscriptTool[], skip: ReadonlySet<string>): string[] =>
    tools.flatMap((tool) => [...(skip.has(tool.id) ? [] : [tool.target ?? tool.input ?? ""].filter((said) => said !== "")), ...targetsOf(tool.children ?? [], skip)]);

// The loopback ports a conversation's turns have reached, gathered at each one's ending: a port the agent looked at
// before is its preview, whichever turn restarts the server behind it. Memory only, like the turns it is read from.
const REACHED: Holding<ReadonlySet<number>> = { name: "reached ports" };

type JobFateVerdict = "handed" | "stopped" | "awaited";

/**
 * One job's fate from what its turn did: `kept` whether the agent kept it for the person, `ports` where it listens,
 * `targets` what the turn's calls acted on, `handed` ports this conversation already left for the person (a restarted
 * server keeps its standing without being kept twice), `reachedBefore` ports its earlier turns reached, `waiting`
 * whether it sits at a prompt nobody will answer, `leftover` whether a cut-off turn left it awaited and this clean run
 * never reached it.
 */
export const jobFate = (fact: {
    readonly kept: boolean;
    readonly ports: readonly number[];
    readonly targets: readonly string[];
    readonly handed: ReadonlySet<number>;
    readonly reachedBefore: ReadonlySet<number>;
    readonly waiting: boolean;
    readonly leftover?: boolean;
}): JobFateVerdict => {
    if (fact.kept || fact.ports.some((port) => fact.handed.has(port))) {
        return "handed";
    }
    if (fact.ports.some((port) => fact.reachedBefore.has(port) || fact.targets.some((target) => reachedAt(port).test(target)))) {
        return "stopped";
    }
    return fact.waiting || fact.leftover === true ? "stopped" : "awaited";
};

// Whether a run's calls reached a job by what the agent knows it as: the id `wait` takes, the CLI's own task id, or its
// capture dir (its output file is in it).
const reachesJob = (targets: readonly string[], judged: JudgedJob): boolean =>
    targets.some((target) => target.includes(judged.job.id) || target.includes(judged.job.dir) || (judged.shellId !== undefined && target.includes(judged.shellId)));

// Disarming a watch that already fired or was stopped is nothing to report; any other failure is logged, never thrown,
// since a stop must end the job whatever the watch journal did.
const disarmWith =
    (logger: Logger) =>
    async (conversationId: string, watchId: string): Promise<void> => {
        try {
            await cancelWatcher(conversationId, watchId);
        } catch (error) {
            logger.warn({ err: error, conversationId, watch: watchId }, "background job: its watch could not be disarmed, its exit may still wake the conversation");
        }
    };

/** Stops one job for whoever asked, disarming the watch it was handed to first; never throws. */
export const stopJob = async (deps: Omit<JobFateDeps, "scanPorts">, job: BackgroundJob, by: JobStopper): Promise<boolean> => {
    try {
        return await stopBackgroundJob(deps.conversations, job, by, disarmWith(deps.logger));
    } catch (error) {
        deps.logger.warn({ err: error, job: job.id, conversationId: job.conversationId }, "background job: stopping it failed");
        return false;
    }
};

// The call that started a job, so its own command line is never read as the agent using what it started.
const starterOf = (judged: JudgedJob): ReadonlySet<string> => new Set(judged.toolUseId === undefined ? [] : [judged.toolUseId]);

// The loopback ports the conversation's earlier turns reached, this turn's joining them for the next: read before they
// join, so the answer is only ever what earlier turns did. The calls that started jobs are left out, as a turn's own
// reach leaves them out.
const reachedBeforeThis = (deps: JobFateDeps, conversationId: string, rows: LiveRun["rows"], jobs: readonly JudgedJob[]): ReadonlySet<number> => {
    const starters = new Set(jobs.flatMap((judged) => [...starterOf(judged)]));
    const reached = deps.conversations.holdings(REACHED);
    const before = reached.get(conversationId) ?? new Set<number>();
    reached.hold(conversationId, conversationId, new Set([...before, ...portsNamed(rows.flatMap((row) => targetsOf(row.tools ?? [], starters)))]));
    return before;
};

// Carries out one verdict: hands the job over (disarming a watch an earlier ending gave it), or stops it.
const carryOut = async (
    deps: JobFateDeps,
    judged: JudgedJob,
    verdict: JobFateVerdict,
    ports: readonly number[],
    waiting: ReturnType<typeof jobInputWait>,
    leftover: boolean,
): Promise<void> => {
    const { job, kept } = judged;
    const { conversationId } = job;
    if (verdict === "handed") {
        const watch = handJobOver(deps.conversations, job, ports);
        if (watch !== undefined) {
            await disarmWith(deps.logger)(conversationId, watch);
        }
        deps.logger.info({ conversationId, job: job.id, ports, kept }, "background job: left running for the person, kept for them or on a port already handed over");
        return;
    }
    if (verdict !== "stopped") {
        return;
    }
    if (waiting === undefined && leftover) {
        deps.logger.info({ conversationId, job: job.id, label: job.label }, "background job: stopped, a cut-off turn left it and the run that carried the work on finished without it");
    } else if (waiting === undefined) {
        deps.logger.info({ conversationId, job: job.id, ports }, "background job: stopped with its turn, which used it and handed it to nobody");
    } else {
        deps.logger.warn({ conversationId, job: job.id, program: waiting.program, since: waiting.since }, "background job: stopped with its turn, it was waiting for input nobody would type");
    }
    // Not awaited: marking it is what frees the land, and the processes take their grace in the background.
    void stopJob(deps, job, "turn");
};

/**
 * Judges every job the conversation still has running as its turn ends, once per run: the turn's close asks it first,
 * whatever way the turn ended, before it arms the wakes the awaited ones are handed to and before any land (so a
 * reclaimed server no longer holds it). Never throws: a turn's ending must not fail on it, and a job it could not judge
 * stays awaited. `clean`: the run ended rather than failed, which is what lets it settle a job a cut-off turn left.
 */
export const resolveTurnJobs = async (deps: JobFateDeps, conversationId: string, ending: { readonly clean: boolean } = { clean: true }): Promise<void> => {
    const run = turnRunOf(deps.conversations, conversationId);
    if (run === undefined) {
        return;
    }
    try {
        const jobs = jobsToJudge(deps.conversations, conversationId);
        // Gathered even with nothing to judge, so a later turn's restarted preview is known as one.
        const reachedBefore = reachedBeforeThis(deps, conversationId, run.rows, jobs);
        if (jobs.length === 0) {
            return;
        }
        const [listeners, panes] = await Promise.all([deps.scanPorts(), jobPanes(jobs.map(({ job }) => job))]);
        const handed = handedPorts(deps.conversations, conversationId);
        for (const judged of jobs) {
            const pane = panes.get(judged.job.dir);
            const ports = pane === undefined ? [] : listeners.filter((listener) => listener.pane === pane).map((listener) => listener.port);
            const targets = run.rows.flatMap((row) => targetsOf(row.tools ?? [], starterOf(judged)));
            const waiting = jobInputWait(judged.job);
            const reached = judged.cut && reachesJob(targets, judged);
            const leftover = judged.cut && ending.clean && !reached;
            const verdict = jobFate({ kept: judged.kept, ports, targets, handed, reachedBefore, waiting: waiting !== undefined, leftover });
            if (verdict === "awaited" && reached) {
                awaitedByRun(deps.conversations, judged.job);
            }
            await carryOut(deps, judged, verdict, ports, waiting, leftover);
        }
    } catch (error) {
        deps.logger.warn({ err: error, conversationId }, "background job: the turn's jobs could not be judged, each stays awaited");
    }
};
