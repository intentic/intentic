import type { TranscriptTool } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { turnRunOf } from "../../../conversations/actor/conversation-holdings.js";
import type { ListeningPort } from "../../../ports/port-scan.js";
import { cancelWatcher } from "../../verification/watchers.js";
import {
    type BackgroundJob,
    handedPorts,
    handJobOver,
    jobPanes,
    type JobStopper,
    jobsToJudge,
    stopBackgroundJob,
} from "./background-jobs.js";

// What happens to what a turn leaves running, decided the moment it ends, from facts the sandbox holds and never from
// the turn's prose. A job goes one of three ways:
// - handed over, when the agent kept it for the person with the `keep` tool (keepBackgroundJob), or it listens on a port
//   this conversation already handed over (a restarted server): it keeps running, wakes nothing and holds no land, and
//   the person stops it (chat, Preview). The reply's words decide nothing: "I stopped the old server and started a fresh
//   one at http://localhost:5173" hands one over and "I stopped the server on localhost:5173" does not, and no reading
//   of either sentence told them apart;
// - stopped, when it listens on a port the turn reached itself and nobody kept it: the instrument of the agent's own
//   look, which the sandbox reclaims rather than leave holding memory, the land and a six-hour watch;
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

// What a call acted on, its helpers' calls included; never what it printed, where a test suite's own log would name
// its server. The call that started a job is left out, so a command that starts a server and never reaches it is not
// read as reaching it.
const targetsOf = (tools: readonly TranscriptTool[], skip: string | undefined): string[] =>
    tools.flatMap((tool) => [...(tool.id === skip || tool.target === undefined ? [] : [tool.target]), ...targetsOf(tool.children ?? [], skip)]);

type JobFateVerdict = "handed" | "stopped" | "awaited";

/**
 * One job's fate from what its turn did: `kept` whether the agent kept it for the person, `ports` where it listens,
 * `targets` what the turn's calls acted on, `handed` ports this conversation already left for the person (a restarted
 * server keeps its standing without being kept twice).
 */
export const jobFate = (fact: {
    readonly kept: boolean;
    readonly ports: readonly number[];
    readonly targets: readonly string[];
    readonly handed: ReadonlySet<number>;
}): JobFateVerdict => {
    if (fact.kept || fact.ports.some((port) => fact.handed.has(port))) {
        return "handed";
    }
    return fact.ports.some((port) => fact.targets.some((target) => reachedAt(port).test(target))) ? "stopped" : "awaited";
};

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

/**
 * Judges every job the conversation still has running as its turn ends, once per run: the turn's close asks it first,
 * whatever way the turn ended, before it arms the wakes the awaited ones are handed to and before any land (so a
 * reclaimed server no longer holds it). Never throws: a turn's ending must not fail on it, and a job it could not judge
 * stays awaited.
 */
export const resolveTurnJobs = async (deps: JobFateDeps, conversationId: string): Promise<void> => {
    const run = turnRunOf(deps.conversations, conversationId);
    if (run === undefined) {
        return;
    }
    try {
        const jobs = jobsToJudge(deps.conversations, conversationId);
        if (jobs.length === 0) {
            return;
        }
        const [listeners, panes] = await Promise.all([deps.scanPorts(), jobPanes(jobs.map(({ job }) => job))]);
        const handed = handedPorts(deps.conversations, conversationId);
        for (const { job, toolUseId, kept } of jobs) {
            const pane = panes.get(job.dir);
            const ports = pane === undefined ? [] : listeners.filter((listener) => listener.pane === pane).map((listener) => listener.port);
            const targets = run.rows.flatMap((row) => targetsOf(row.tools ?? [], toolUseId));
            const verdict = jobFate({ kept, ports, targets, handed });
            if (verdict === "handed") {
                const watch = handJobOver(deps.conversations, job, ports);
                if (watch !== undefined) {
                    await disarmWith(deps.logger)(conversationId, watch);
                }
                deps.logger.info({ conversationId, job: job.id, ports, kept }, "background job: left running for the person, kept for them or on a port already handed over");
            } else if (verdict === "stopped") {
                deps.logger.info({ conversationId, job: job.id, ports }, "background job: stopped with its turn, which used it and handed it to nobody");
                // Not awaited: marking it is what frees the land, and the processes take their grace in the background.
                void stopJob(deps, job, "turn");
            }
        }
    } catch (error) {
        deps.logger.warn({ err: error, conversationId }, "background job: the turn's jobs could not be judged, each stays awaited");
    }
};
