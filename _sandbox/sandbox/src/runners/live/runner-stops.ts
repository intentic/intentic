import type { PersistedAgent } from "../../conversations/registry/agents-store.js";
import { opt } from "../../opt.js";
import { olderRunner, type RunnerSockets } from "./runner-calls.js";

/* A person's stop on the card of a conversation that runs on a runner (2026-11-23): its background jobs and armed watches
   live in the runner's actors (runner-feed.ts brings them to the card), so the stop is carried there and answered with
   whether anything stopped. A runner out of reach, or one older than the doors, is said so rather than answered as a stop. */

export type RunnerStop = { readonly kind: "job"; readonly jobId: string } | { readonly kind: "watch"; readonly watchId: string | undefined };

// The runner a conversation is placed on, or undefined for one that runs here.
export const runnerOf = (entry: Pick<PersistedAgent, "placement">): string | undefined =>
    entry.placement.kind === "worktree" ? entry.placement.runner : undefined;

// What the runner did with a stop: whether anything stopped there, and why not when nothing did.
export interface RunnerStopped {
    readonly stopped: boolean;
    readonly reason?: string;
}

// Nothing stopped for a conversation that runs here. A runner out of reach, or older than the door, stops nothing and
// says why, never throws: what this sandbox itself stopped for the same press still stands (card-stops.routes.ts).
export const stopOnRunner = async (
    services: { readonly runnerHub: RunnerSockets },
    entry: Pick<PersistedAgent, "placement" | "id">,
    stop: RunnerStop,
): Promise<RunnerStopped> => {
    const runner = runnerOf(entry);
    if (runner === undefined) {
        return { stopped: false };
    }
    const client = services.runnerHub.client(runner);
    if (client === undefined) {
        return { stopped: false, reason: `${services.runnerHub.offline(runner)} What this conversation left running there can be stopped once it is back.` };
    }
    try {
        const answer =
            stop.kind === "job"
                ? await client.stopJob({ conversationId: entry.id, jobId: stop.jobId })
                : await client.stopWatching({ conversationId: entry.id, ...opt("watchId", stop.watchId) });
        return { stopped: answer.stopped };
    } catch (error) {
        if (error instanceof Error && olderRunner(error)) {
            return {
                stopped: false,
                reason: `The runner "${runner}" runs a build older than stopping from the card; update the runner, or stop it from its own terminal.`,
            };
        }
        throw error;
    }
};
