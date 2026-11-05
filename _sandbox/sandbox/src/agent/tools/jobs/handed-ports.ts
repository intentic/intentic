import type { Logger } from "pino";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import type { ListeningPort } from "../../../ports/port-scan.js";
import { type BackgroundJob, handJobOver, type Holders, JOBS, jobFinished, jobPanes } from "./background-jobs.js";

/* A SERVER HANDED OVER BEFORE IT LISTENED (2026-11-05). A turn's ending hands the person every job the agent kept with
   the ports its pane listened on at that moment (job-fates.ts), and nothing looked again. A kept server still starting
   (an API running its migrations, a Vite behind pnpm and turbo) was handed over with `ports: []` for good: its card's
   "Open in Preview" opened nothing, and Preview never offered it by name. marcin.milczarek's four servers, kept together
   at the end of one turn, sat that way for four hours. A handed job with no port is looked at again: a few times after
   the ending that handed it over, and on every ports listing while it has none. */

export interface HandedPortsDeps {
    readonly conversations: Pick<ConversationActors, "holdings" | "send">;
    readonly logger: Pick<Logger, "info" | "warn">;
}

/** The running jobs left for the person that listened nowhere the sandbox saw when they were handed over. */
export const portlessHandedJobs = (actors: Holders): readonly BackgroundJob[] =>
    actors
        .holdings(JOBS)
        .entries()
        .map(([, record]) => record)
        .filter((record) => record.fate === "handed" && (record.ports ?? []).length === 0 && !jobFinished(record.job))
        .map((record) => record.job);

// The listener lists already looked through. The shared scan answers the same list while no socket opened or closed
// (ports/port-scan.ts cachedScan), and the same listeners name the same ports, so the desktop mirror's five-second poll
// of the ports list costs a walk of /proc only when a socket changed.
const looked = new WeakSet<readonly ListeningPort[]>();

/** Names the port of every job left for the person with none, from listeners attributed to its pane; never throws. */
export const reattributeHandedPorts = async (deps: HandedPortsDeps, listeners: readonly ListeningPort[]): Promise<void> => {
    const jobs = portlessHandedJobs(deps.conversations);
    if (jobs.length === 0 || looked.has(listeners)) {
        return;
    }
    looked.add(listeners);
    try {
        const panes = await jobPanes(jobs);
        for (const job of jobs) {
            const pane = panes.get(job.dir);
            const ports = pane === undefined ? [] : listeners.filter((listener) => listener.pane === pane).map((listener) => listener.port);
            // Handing it over again only names its ports: it was handed over already, so it holds no watch or notice.
            if (ports.length > 0 && portlessHandedJobs(deps.conversations).includes(job)) {
                handJobOver(deps.conversations, job, ports);
                deps.logger.info({ conversationId: job.conversationId, job: job.id, ports }, "background job: left for the person with no port, now seen listening");
            }
        }
    } catch (error) {
        deps.logger.warn({ err: error }, "background job: the ports of jobs left for the person could not be looked at again");
    }
};

// After the ending that handed a job over listening nowhere: soon, for a server still starting, then less often.
const RECHECK_MS = [5_000, 20_000, 60_000, 180_000] as const;

/** Looks again for the ports of the jobs left for the person with none, on RECHECK_MS, until none is left without one. */
export const recheckHandedPorts = (deps: HandedPortsDeps & { readonly scanPorts: () => Promise<readonly ListeningPort[]> }, at = 0): void => {
    const delay = RECHECK_MS[at];
    if (delay === undefined) {
        return;
    }
    const timer = setTimeout(() => {
        if (portlessHandedJobs(deps.conversations).length === 0) {
            return;
        }
        void deps
            .scanPorts()
            .then((listeners) => reattributeHandedPorts(deps, listeners))
            .catch((error: Error) => {
                deps.logger.warn({ err: error }, "background job: the ports could not be scanned for jobs left for the person");
            })
            .finally(() => {
                recheckHandedPorts(deps, at + 1);
            });
    }, delay);
    // A recheck never holds the daemon up.
    timer.unref();
};
