import type { Services } from "../../../composition.js";
import { defineInFlight } from "../../../seams/restart/in-flight.js";
import { adoptBackgroundJobs } from "./background-adoption.js";
import { leftJobs, restoreBackgroundJobs } from "./background-jobs.js";
import { settleLostRuns } from "./job-files.js";
import { keptJobReceipts, reportLostKeptJobs } from "./kept-job-records.js";

// The agent commands a restart left, as boot recovers them (bootstrap/restart/in-flight-kinds.ts): each job's own file in its capture
// dir, and, beside the history volume, the receipt of one kept for the person.

/**
 * Every run the restart took down has its end written for it first, so the watch waiting on it reports the loss at its
 * first look (job-files.ts); then each job still running is taken back, and one whose turn died before adopting it is
 * adopted now, or its ending would reach nobody.
 */
export const backgroundJobsInFlight = defineInFlight({
    name: "background jobs",
    read: async () => leftJobs(),
    recover: async (services: Pick<Services, "conversations" | "logger">, left) => {
        const lost = await settleLostRuns().catch((error: Error) => {
            services.logger.warn({ err: error }, "agent commands the restart took down could not be written down, their watches wait out their deadlines");
            return [];
        });
        if (lost.length > 0) {
            services.logger.warn({ dirs: lost }, "agent commands the restart took down were written down as lost, their watches report it now");
        }
        const jobs = restoreBackgroundJobs(services.conversations, left);
        if (jobs.length > 0) {
            services.logger.info({ jobs: jobs.length }, "background jobs still running were taken back, their terminals are spared");
        }
        for (const conversationId of new Set(jobs.map((job) => job.conversationId))) {
            // The restart cut the turn that would have adopted them: nobody chose to wait on these.
            void adoptBackgroundJobs(services.conversations, conversationId, services.logger, { cut: true });
        }
    },
});

/** A kept command cannot be replayed after a container loss: each one gone is said in Activity, then its receipt retired. */
export const keptJobsInFlight = defineInFlight({
    name: "kept jobs",
    claim: "container",
    read: async (services: Pick<Services, "config">) => keptJobReceipts(services.config.historyRoot),
    recover: async (services: Pick<Services, "config" | "activity">, left) => reportLostKeptJobs(services.config.historyRoot, left, services.activity),
});
