import type { Logger } from "pino";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { JOBS, jobFinished } from "../../tools/jobs/background-jobs.js";
import { stopJob } from "../../tools/jobs/job-fates.js";
import { cancelWatchersFor } from "../../verification/watchers.js";
import type { HaltedBy } from "../../../conversations/actor/conversation-halt.js";

// WHAT A HALTED CONVERSATION COULD STILL BE WOKEN BY, TAKEN AWAY (conversations/actor/conversation-halt.ts). Run once its turn has stopped, or at once
// for one at rest that waits on a wake of its own: the background jobs it left running are stopped (a server it kept for
// the person stays theirs), every watch it armed or that a job of its was handed to is disarmed, the re-run the sandbox
// booked for it is dropped, and the sandbox's words queued for it are taken out. A person's queued words stay: they are
// the person's to send or take back. Each of these is on the record, so a restart afterwards finds nothing to wake it.

export interface HaltQuietDeps {
    readonly conversations: Pick<ConversationActors, "holdings" | "send" | "state" | "queued">;
    readonly logger: Pick<Logger, "info" | "warn">;
}

/** What quieting a halted conversation took away, by kind. */
export interface Quieted {
    readonly jobs: number;
    readonly watches: number;
    readonly rerun: boolean;
    readonly words: number;
}

// Its running jobs, less the ones the agent left to the person: those wake nothing and are the person's to stop.
const stopJobs = async (deps: HaltQuietDeps, conversationId: string, by: HaltedBy): Promise<number> => {
    const running = deps.conversations
        .holdings(JOBS)
        .of(conversationId)
        .filter((record) => !jobFinished(record.job) && record.fate !== "handed" && record.fate !== "stopped" && record.kept === undefined);
    const stopped = await Promise.all(running.map((record) => stopJob(deps, record.job, by)));
    return stopped.filter(Boolean).length;
};

// The re-run the sandbox booked for it, dropped unless it already fired; one of a person's own turn stays theirs.
const dropRerun = (deps: HaltQuietDeps, conversationId: string): boolean => {
    const held = deps.conversations.state(conversationId)?.resume.held;
    if (held === undefined || held.fired || held.input.speaker?.kind === "person") {
        return false;
    }
    deps.conversations.send(conversationId, { kind: "resume-dropped" });
    return true;
};

// The sandbox's own words waiting in its queue (a child's report, a watch's wake, a land follow-up).
const dropSandboxWords = (deps: HaltQuietDeps, conversationId: string): number => {
    const sandbox = deps.conversations.queued(conversationId).items.filter((item) => item.voice === "sandbox");
    for (const item of sandbox) {
        deps.conversations.send(conversationId, { kind: "queue-removed", id: item.id, revision: item.revision });
    }
    return sandbox.length;
};

/** Takes away everything that could wake a halted conversation by itself; never throws, since it runs off a cancel. */
export const quietHalted = async (deps: HaltQuietDeps, conversationId: string, by: HaltedBy): Promise<Quieted> => {
    let quieted: Quieted = { jobs: 0, watches: 0, rerun: false, words: 0 };
    try {
        // Jobs first: stopping one disarms the watch it was handed to, which then wakes nothing.
        const jobs = await stopJobs(deps, conversationId, by);
        const watches = await cancelWatchersFor(conversationId);
        quieted = { jobs, watches, rerun: dropRerun(deps, conversationId), words: dropSandboxWords(deps, conversationId) };
    } catch (error) {
        deps.logger.warn({ err: error, conversationId }, "cancel: what could wake the cancelled conversation could not all be taken away");
    }
    if (quieted.jobs + quieted.watches + quieted.words > 0 || quieted.rerun) {
        deps.logger.info({ conversationId, by, ...quieted }, "cancel: took away what would have woken the cancelled conversation");
    }
    return quieted;
};
