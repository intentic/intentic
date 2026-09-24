import type { TranscriptRow, TranscriptTool } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { ConversationActors } from "../../agents/actor/conversation-actors.js";
import { turnRunOf } from "../../agents/actor/conversation-holdings.js";
import type { ListeningPort } from "../../ports/port-scan.js";
import { cancelWatcher } from "../verification/watchers.js";
import {
    type BackgroundJob,
    handedPorts,
    handJobOver,
    jobPanes,
    type JobStopper,
    jobsToJudge,
    stopBackgroundJob,
} from "./background-jobs.js";

// What happens to what a turn leaves running, decided the moment it ends, from facts the sandbox already holds rather
// than anything the agent is told to declare. A job listening on a port is a server; the rest is work whose exit the
// conversation waits on (background-adoption.ts), as it always was. A server goes one of two ways:
// - handed over, when the turn's last reply gives its address: an agent that runs something FOR the person has to say
//   where it is, so it keeps running, wakes nothing and holds no land, and the person stops it (chat, Preview);
// - stopped, when the turn reached it itself and said nothing about it: the instrument of the agent's own look, which
//   the sandbox reclaims rather than leave holding memory, the land and a six-hour watch.
// A listener the turn never reached (a test suite's own server mid-run) is neither: its job stays awaited, so a turn
// that ended to wait on its tests is not robbed of them.

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

// The reply handing it over: any address carrying the port (a loopback one, a hostname, a bare `:5173`), or the port
// named as one.
const namedIn = (port: number): RegExp => new RegExp(`(?:${LOOPBACK}|[\\w.-]*):${String(port)}(?!\\d)|\\bport\\s+${String(port)}(?!\\d)`, "iu");

// What a call acted on, its helpers' calls included; never what it printed, where a test suite's own log would name
// its server. The call that started a job is left out, so a command that starts a server and never reaches it is not
// read as reaching it.
const targetsOf = (tools: readonly TranscriptTool[], skip: string | undefined): string[] =>
    tools.flatMap((tool) => [...(tool.id === skip || tool.target === undefined ? [] : [tool.target]), ...targetsOf(tool.children ?? [], skip)]);

// The turn's last words: what the person reads when it ends, so the one place an address given to them sits.
const closingOf = (rows: readonly TranscriptRow[]): string => rows.findLast((row) => row.role === "assistant" && row.text.trim() !== "")?.text ?? "";

type JobFateVerdict = "handed" | "stopped" | "awaited";

/**
 * One job's fate from what its turn did: `ports` are where it listens, `targets` what the turn's calls acted on,
 * `closing` its last reply, `handed` ports this conversation already left for the person (a restarted server keeps
 * its standing without being named twice).
 */
export const jobFate = (fact: {
    readonly ports: readonly number[];
    readonly targets: readonly string[];
    readonly closing: string;
    readonly handed: ReadonlySet<number>;
}): JobFateVerdict => {
    if (fact.ports.length === 0) {
        return "awaited";
    }
    if (fact.ports.some((port) => fact.handed.has(port) || namedIn(port).test(fact.closing))) {
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
 * Judges every job the conversation still has running as its turn ends: once before the land (so a reclaimed server
 * no longer holds it), again at the settle for a turn that never reached its land; each run's ending judges a job
 * once. Never throws: a turn's ending must not fail on it, and a job it could not judge stays awaited.
 */
export const resolveTurnJobs = async (deps: JobFateDeps, conversationId: string): Promise<void> => {
    const run = turnRunOf(deps.conversations, conversationId);
    if (run === undefined) {
        return;
    }
    try {
        const jobs = jobsToJudge(deps.conversations, conversationId, run.id);
        if (jobs.length === 0) {
            return;
        }
        const [listeners, panes] = await Promise.all([deps.scanPorts(), jobPanes(jobs.map(({ job }) => job))]);
        const closing = closingOf(run.rows);
        const handed = handedPorts(deps.conversations, conversationId);
        for (const { job, toolUseId } of jobs) {
            const pane = panes.get(job.dir);
            const ports = pane === undefined ? [] : listeners.filter((listener) => listener.pane === pane).map((listener) => listener.port);
            const targets = run.rows.flatMap((row) => targetsOf(row.tools ?? [], toolUseId));
            const verdict = jobFate({ ports, targets, closing, handed });
            if (verdict === "handed") {
                const watch = handJobOver(deps.conversations, job, ports);
                if (watch !== undefined) {
                    await disarmWith(deps.logger)(conversationId, watch);
                }
                deps.logger.info({ conversationId, job: job.id, ports }, "background job: left running for the person, its turn's reply gave its address");
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
