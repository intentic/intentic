import type { MainlineLandRef, MainlineProject, MainlineRun, MainlineStatus } from "@intentic/sandbox-contract";
import { panelSession } from "@intentic/sandbox-contract/session-names";
import type { Services } from "../../composition.js";
import { publicPushes } from "./push-checks-store.js";
import type { QueuedLand, Streak } from "./verify-store.js";
import { opt } from "../../opt.js";
import { failureOf } from "./failure-units.js";
import { mainlineLandOf, verifyPanelKey } from "./verify-deps.js";

// The main-line check as the editor reads it (GET /workspace/mainline): what runs now, from the land check; what waits,
// the last run and the red streak per project, and the latest runs with what became of each red one, from the verify
// store. The only verification the sandbox runs on work, so it is shown rather than hidden in a terminal. Beside it, what
// each push check let through and what became of it, from the push-checks store.

// A run with its failures split the way a reader scans them.
const withUnits = (run: MainlineRun): MainlineRun => (run.failures.length === 0 ? run : { ...run, units: run.failures.map(failureOf) });

// A red streak as the router laid it: the streak's Red (verify-store.ts, `streaks`), which land-breakage.ts files as each
// run settles and each decision is made, names the cause, whether blame narrowed it, and the latest decision. Read,
// never re-derived: the editor's rail, cards and panel all show this one answer. A streak filed before the Red was kept
// reads the same off its runs.
const redOf = (runs: readonly MainlineRun[], record: Streak | undefined, project: string, since: number): NonNullable<MainlineProject["red"]> => {
    const streak = runs.filter((run) => run.project === project && run.status === "red" && run.at >= since);
    const titleOf = (conversationId: string): MainlineLandRef => {
        const title = streak.flatMap((run) => run.lands).find((land) => land.conversationId === conversationId)?.title;
        return { conversationId, ...opt("title", title) };
    };
    if (record?.since === since && (record.suspects.length > 0 || record.decisions.length > 0)) {
        return { since, cause: record.suspects.map(titleOf), named: record.named, ...opt("fixer", record.decisions.at(-1)) };
    }
    return redOfRuns(streak, since, titleOf);
};

const redOfRuns = (
    streak: readonly MainlineRun[],
    since: number,
    titleOf: (conversationId: string) => MainlineLandRef,
): NonNullable<MainlineProject["red"]> => {
    const laid = streak.find((run) => (run.suspects?.length ?? 0) > 0 && run.routing?.kind !== "resolved");
    const fixer = streak.find((run) => run.routing !== undefined)?.routing;
    return {
        since,
        cause: (laid?.suspects ?? []).map(titleOf),
        // A run filed before blame said whether it narrowed named its suspects only when it did, or when it had one land.
        named: laid?.named ?? laid?.suspects?.length === 1,
        ...(fixer === undefined ? {} : { fixer }),
    };
};

export const mainlineStatus = async (deps: Pick<Services, "verifyStore" | "pushChecks" | "landCheck">): Promise<MainlineStatus> => {
    const [{ projects, runs }, lands, streaks, { pushes }] = await Promise.all([
        deps.verifyStore.read(),
        deps.verifyStore.lands(),
        deps.verifyStore.streaks(),
        deps.pushChecks.store.read(),
    ]);
    const current = deps.landCheck.current();
    const waiting = (dir: string): readonly QueuedLand[] =>
        (lands[dir] ?? []).filter((land) => !(current?.dir === dir && current.lands.some((covered) => covered.agentId === land.agentId && covered.at === land.at)));
    const dirs = new Set([
        ...Object.keys(projects),
        ...(current === undefined ? [] : [current.dir]),
        ...Object.keys(lands).filter((dir) => waiting(dir).length > 0),
    ]);
    const projectOf = (dir: string): MainlineProject => {
        const outcome = projects[dir];
        const last = runs.find((run) => run.project === dir);
        return {
            project: dir,
            ...(current?.dir === dir
                ? {
                      running: {
                          command: current.command,
                          startedAt: current.startedAt,
                          lands: current.lands.map(mainlineLandOf),
                          ...(current.on === undefined ? {} : { on: current.on }),
                      },
                  }
                : {}),
            queued: waiting(dir).map(mainlineLandOf),
            session: panelSession(verifyPanelKey(dir)),
            ...(last === undefined ? {} : { last: withUnits(last) }),
            ...(outcome?.status === "red" ? { redSince: outcome.since ?? outcome.at, red: redOf(runs, streaks[dir], dir, outcome.since ?? outcome.at) } : {}),
        };
    };
    return { projects: [...dirs].toSorted().map(projectOf), recent: runs.map(withUnits), pushes: publicPushes(pushes) };
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
