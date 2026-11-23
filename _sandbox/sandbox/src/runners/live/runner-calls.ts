import { ORPCError } from "@orpc/server";
import type { RunnerClient, RunnerHub } from "../runner-peer.js";

/* What every live-view call to a runner shares (2026-11-23): an older runner lacks the door and answers NOT_FOUND, which
   each caller reads as "show what this sandbox has", never as a failure of the whole answer; and a list read across the
   runners waits on none of them for long, since one asleep behind a half-open socket must not hold the editor's list. */

// The enrolled runners, as far as a live view reads them (runner-peer.ts RunnerStore).
export interface RunnerRoster {
    readonly list: () => Promise<readonly { readonly id: string }[]>;
}

// A runner's socket, as far as a live view reads it: its client, and the sentence for one that is away.
export type RunnerSockets = Pick<RunnerHub, "client" | "offline">;

// How long a list waits on any one runner before leaving it out.
const RUNNER_LIST_MS = 4000;

// Whether a call failed only because the runner is older than the door: its procedure is not there.
export const olderRunner = (error: Error): boolean => error instanceof ORPCError && error.code === "NOT_FOUND";

// Every enrolled runner holding a socket now, with its client.
const onlineRunners = async (
    runners: RunnerRoster,
    hub: Pick<RunnerHub, "client">,
): Promise<{ readonly id: string; readonly client: RunnerClient }[]> =>
    (await runners.list()).flatMap((runner) => {
        const client = hub.client(runner.id);
        return client === undefined ? [] : [{ id: runner.id, client }];
    });

// One read from each online runner, each bounded by RUNNER_LIST_MS; a runner that is older, slow or failing is left out.
export const fromEachRunner = async <T>(
    runners: RunnerRoster,
    hub: Pick<RunnerHub, "client">,
    read: (client: RunnerClient, signal: AbortSignal) => Promise<T>,
    warn?: (runner: string, error: Error) => void,
): Promise<{ readonly runner: string; readonly value: T }[]> => {
    const online = await onlineRunners(runners, hub);
    const answers = await Promise.all(
        online.map(async ({ id, client }) => {
            try {
                return { runner: id, value: await read(client, AbortSignal.timeout(RUNNER_LIST_MS)) };
            } catch (error) {
                const failure = error instanceof Error ? error : new Error(String(error));
                if (!olderRunner(failure)) {
                    warn?.(id, failure);
                }
                return undefined;
            }
        }),
    );
    return answers.filter((answer) => answer !== undefined);
};
