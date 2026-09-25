import type { MainlineProject, MainlineStatus } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { publicPushes } from "./push-checks-store.js";
import { mainlineLandOf, verifyQueueSnapshot } from "./verify-deps.js";

// The main-line check as the editor reads it (GET /workspace/mainline): what runs now and what waits, from the queue in
// memory; the last run and the red streak per project, and the latest runs with what became of each red one, from the
// verify store. The only verification the sandbox runs on work, so it is shown rather than hidden in a terminal. Beside
// it, what each push check let through and what became of it, from the push-checks store.

export const mainlineStatus = async (deps: Pick<Services, "verifyStore" | "pushChecks">): Promise<MainlineStatus> => {
    const [{ projects, runs }, { pushes }] = await Promise.all([deps.verifyStore.read(), deps.pushChecks.store.read()]);
    const { current, pending } = verifyQueueSnapshot();
    const dirs = new Set([...Object.keys(projects), ...(current === undefined ? [] : [current.dir]), ...pending.flatMap(({ dirs: each }) => each)]);
    const projectOf = (dir: string): MainlineProject => {
        const outcome = projects[dir];
        const last = runs.find((run) => run.project === dir);
        return {
            project: dir,
            ...(current?.dir === dir
                ? { running: { command: current.command, startedAt: current.startedAt, lands: current.lands.map(mainlineLandOf) } }
                : {}),
            queued: pending.filter((entry) => entry.dirs.includes(dir)).flatMap((entry) => entry.lands.map(mainlineLandOf)),
            ...(last === undefined ? {} : { last }),
            ...(outcome?.status === "red" ? { redSince: outcome.since ?? outcome.at } : {}),
        };
    };
    return { projects: [...dirs].toSorted().map(projectOf), recent: [...runs], pushes: publicPushes(pushes) };
};

// The projects red right now with what they fail on, for the note a turn is told (mainline-note.ts): the failures of
// each red project's latest run, since the verdict's own list is the one the next red is measured against.
export const knownReds = async (
    deps: Pick<Services, "verifyStore">,
): Promise<readonly { readonly project: string; readonly since: number; readonly failures: readonly string[]; readonly failureCount: number; readonly lands: readonly string[] }[]> => {
    const { projects, runs } = await deps.verifyStore.read();
    return Object.entries(projects)
        .filter(([, outcome]) => outcome.status === "red")
        .map(([project, outcome]) => {
            const last = runs.find((run) => run.project === project && run.status === "red");
            return {
                project,
                since: outcome.since ?? outcome.at,
                failures: last?.failures ?? (outcome.failures ?? []).slice(0, 30),
                failureCount: last?.failureCount ?? outcome.failures?.length ?? 0,
                lands: (last?.lands ?? []).map((land) => land.title ?? land.conversationId),
            };
        })
        .toSorted((left, right) => (left.project < right.project ? -1 : 1));
};
