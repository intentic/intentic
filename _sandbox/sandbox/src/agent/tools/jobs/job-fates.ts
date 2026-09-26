import type { TranscriptRow, TranscriptTool } from "@intentic/sandbox-contract";
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

// What happens to what a turn leaves running, decided the moment it ends, from facts the sandbox already holds rather
// than anything the agent is told to declare. A job listening on a port is a server; the rest is work whose exit the
// conversation waits on (background-adoption.ts), as it always was. A server goes one of two ways:
// - handed over, when the turn reached it itself and its last reply gives it to the person as a link (`http://host:port`,
//   in a sentence that is not about stopping it): an agent that runs something FOR the person checks it answers and
//   says where it is, so it keeps running, wakes nothing and holds no land, and the person stops it (chat, Preview). A
//   bare `host:port` or "port 5173" is not a hand-over: "I stopped the server on localhost:5173" names one too, and read
//   as a hand-over it kept the server the turn had just stopped;
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

// The reply handing it over: a link carrying the port, the one form an address is given to somebody to open.
const linkTo = (port: number): RegExp => new RegExp(`https?://(?:[\\w.-]+|\\[[\\d:]*\\]):${String(port)}(?!\\d)`, "iu");

// A sentence about ending it, which a link in it does not hand over.
const STOPPING = /\b(?:stop(?:ped|s)?|kill(?:ed|s)?|shut(?:s|ting)?\s+(?:it\s+)?down|terminat(?:ed|es)?|no longer (?:running|up))\b/iu;

// Whether the reply gives the port to the person: a sentence with a link to it that is not about stopping it.
const handedIn = (closing: string, port: number): boolean =>
    closing.split(/(?<=[.!?])\s+|\n+/u).some((sentence) => linkTo(port).test(sentence) && !STOPPING.test(sentence));

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
    if (fact.ports.some((port) => fact.handed.has(port))) {
        return "handed";
    }
    const reached = fact.ports.filter((port) => fact.targets.some((target) => reachedAt(port).test(target)));
    if (reached.length === 0) {
        return "awaited";
    }
    // Only a server the turn itself reached can be handed over: it has checked the address it gives answers.
    return reached.some((port) => handedIn(fact.closing, port)) ? "handed" : "stopped";
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
                deps.logger.info({ conversationId, job: job.id, ports }, "background job: left running for the person, its turn reached it and its reply gave its link");
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
