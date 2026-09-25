import { type MainlineRouting, MainlineRunSchema, type MainlineRun } from "@intentic/sandbox-contract";
import { z } from "zod";
import { publishRuntimeChange } from "../../seams/runtime-feed.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { type JsonFile, jsonFile } from "../../store/json-file.js";
import { objectParse } from "../../store/unknown-keys.js";
import { stateRelPath } from "../../state-paths.js";

// The main-line check's memory (<workspace>/.intentic/records/verify.json): last check outcome per project and its
// consecutive red streak, the latest runs across every project with what became of each red one, the lands no run has
// answered yet, and what the breakage router carries for a red streak, across restarts.
// - deps.fixed is an edge: green after red is news, green after green isn't.
// - attempt counts post-land reds since the last green, for a fix guard to cap on.
// - since is when the red streak began: a fresh fix-up's id is derived from it, so one streak is one failure.
// - red() is the closure re-check's worklist.
// - failures are the last verdict's units, so the next red names only what appeared since.
// - runs is what the editor's strip and every card read (mainline-status.ts), newest first.
// - lands wait per project until a run with a verdict answers them: a run that ends without one (skipped by the queue,
//   past the watch window, an install that never settled) leaves them for the next, which measures their sum.
// - streaks is the router's (land-breakage.ts): what a red waits or holds on, and who was told, until the project is green.
// Every write is published to the main-line feed, so no writer can forget to tell the editor.

const OutcomeSchema = z.object({
    status: z.enum(["green", "red"]),
    // Consecutive red verdicts since the last green; 0 while green.
    attempt: z.number(),
    at: z.number(),
    // What the check failed on, as its own report named it; absent when it wrote none.
    failures: z.array(z.string()).optional(),
    // When the current red streak began; absent while green.
    since: z.number().optional(),
});

// A land waiting for its check: the conversation, the branch and the span it landed, and when it asked.
const QueuedLandSchema = z.object({
    kind: z.literal("land"),
    agentId: z.string(),
    title: z.string().optional(),
    branch: z.string(),
    repos: z.array(z.object({ repo: z.string(), from: z.string(), dir: z.string() })),
    at: z.number(),
});
export type QueuedLand = z.infer<typeof QueuedLandSchema>;

// What a red carried forward while it waited on the check behind it or held on a conversation still working: the failures
// still owed, the lands they may have come with, and the runs whose routing is decided with it.
const CarriedSchema = z.object({
    command: z.string(),
    fresh: z.array(z.string()),
    failures: z.array(z.string()),
    logTail: z.string(),
    measured: z.boolean(),
    lands: z.array(QueuedLandSchema),
    runs: z.array(z.number()),
    waits: z.number(),
    // When it first held on a conversation still working, carried across re-holds so the hold's bound is one bound.
    heldSince: z.number().optional(),
    // The conversations it holds on; empty while it only waits for the next check.
    on: z.array(z.string()).default([]),
});
export type Carried = z.infer<typeof CarriedSchema>;

// The router's memory of one red streak.
const StreakSchema = z.object({
    since: z.number(),
    carried: CarriedSchema.optional(),
    // Conversations still working that were told once this streak that their work touches what failed.
    told: z.array(z.string()).default([]),
});
export type Streak = z.infer<typeof StreakSchema>;

const VerifyStateSchema = z.object({
    projects: z.record(z.string(), OutcomeSchema),
    // Newest first, bounded; written by the check itself and by whoever decides what a red one's failures are owed.
    runs: z.array(MainlineRunSchema).default([]),
    lands: z.record(z.string(), z.array(QueuedLandSchema)).default({}),
    streaks: z.record(z.string(), StreakSchema).default({}),
});
export type VerifyState = z.infer<typeof VerifyStateSchema>;

export const verifyDocument = defineDocument({ path: stateRelPath(".intentic/records/verify.json"), schema: VerifyStateSchema });

// Runs kept across every project: enough for each recent land's card to find the run that answered for it.
export const RUNS_KEPT = 40;

export type VerifyOutcome = z.infer<typeof OutcomeSchema>;

// What one recorded verdict means to whoever announces it; attempt is already advanced or reset accordingly.
export interface RecordedVerdict {
    // "broken" on every red (fresh news each time); "fixed" only on a red→green edge; undefined otherwise.
    readonly edge: "broken" | "fixed" | undefined;
    readonly attempt: number;
    // Failures this red names that the verdict before it did not, counted per unit; undefined when no report was read.
    readonly fresh?: readonly string[];
    // When the red streak began: the one this red extends or starts, or the one a green just ended.
    readonly since?: number;
}

export interface VerifyStore {
    // Project dirs whose last verdict was red; the closure re-check's worklist.
    readonly red: () => Promise<string[]>;
    readonly record: (dir: string, status: "green" | "red", at: number, failures?: readonly string[]) => Promise<RecordedVerdict>;
    // Every project's last outcome and the latest runs, newest first.
    readonly read: () => Promise<{ readonly projects: Readonly<Record<string, VerifyOutcome>>; readonly runs: readonly MainlineRun[] }>;
    // Files one settled run at the head of the history, and takes the lands it answered for off their project's wait.
    readonly noteRun: (run: MainlineRun) => Promise<void>;
    // What became of a red run's failures, on the run that ended at `at` in `project`; nothing when it has aged out.
    readonly routed: (project: string, at: number, routing: MainlineRouting) => Promise<void>;
    // Who the failures of the runs that ended at `ats` in `project` are laid at, and whether the paths they changed
    // narrowed it to them (false: every land covered, or none when nothing new failed); runs aged out are skipped.
    readonly blamed: (project: string, ats: readonly number[], blame: Blame) => Promise<void>;
    // A land asks for a check in each of `dirs`; it waits there until a run with a verdict answers it.
    readonly owe: (dirs: readonly string[], land: QueuedLand) => Promise<void>;
    // The lands waiting per project, oldest first.
    readonly lands: () => Promise<Readonly<Record<string, readonly QueuedLand[]>>>;
    // The router's memory per project's red streak.
    readonly streaks: () => Promise<Readonly<Record<string, Streak>>>;
    // Changes one project's streak memory; undefined forgets it.
    readonly streak: (project: string, change: (current: Streak | undefined) => Streak | undefined) => Promise<void>;
}

// Who a red run's failures are laid at: the conversations whose lands they may have come with, and whether the paths
// those lands changed narrowed it to them.
export interface Blame {
    readonly suspects: readonly string[];
    readonly named: boolean;
}

// Occurrences in `now` beyond those `before` held, so one more copy of a standing failure still counts as new.
export const freshFailures = (now: readonly string[], before: readonly string[]): string[] => {
    const left = new Map<string, number>();
    for (const unit of before) {
        left.set(unit, (left.get(unit) ?? 0) + 1);
    }
    return now.filter((unit) => {
        const remaining = left.get(unit) ?? 0;
        left.set(unit, remaining - 1);
        return remaining <= 0;
    });
};

type Outcome = z.infer<typeof OutcomeSchema>;

// A red against the red streak it extends, if any: the attempt after its, and what it failed on that the streak had not.
const reddened = (standing: Outcome | undefined, failures: readonly string[] | undefined): RecordedVerdict => ({
    edge: "broken",
    attempt: (standing?.attempt ?? 0) + 1,
    ...(failures === undefined ? {} : { fresh: freshFailures(failures, standing?.failures ?? []) }),
});

// The verdict one run makes against the one before it; attempt advances on red and resets on green.
const judged = (previous: Outcome | undefined, status: "green" | "red", failures: readonly string[] | undefined): RecordedVerdict =>
    status === "red"
        ? reddened(previous?.status === "red" ? previous : undefined, failures)
        : { edge: previous?.status === "red" ? "fixed" : undefined, attempt: 0 };

// A land is one ask: the conversation that landed it and when it asked.
const sameLand = (land: { readonly agentId: string; readonly at: number }, run: { readonly conversationId: string; readonly at: number }): boolean =>
    land.agentId === run.conversationId && land.at === run.at;

// The store over any document handle; the daemon's is the file, a test's lives in memory (testing.ts).
export const verifyStoreOver = (file: Pick<JsonFile<VerifyState>, "read" | "update">): VerifyStore => {
    const update = async (change: (current: VerifyState) => VerifyState): Promise<void> => {
        await file.update(change);
        publishRuntimeChange("mainline");
    };
    return {
        red: async () =>
            Object.entries((await file.read()).projects)
                .filter(([, outcome]) => outcome.status === "red")
                .map(([dir]) => dir),
        record: async (dir, status, at, failures) => {
            let verdict: RecordedVerdict = { edge: undefined, attempt: 0 };
            await update((current) => {
                const previous = current.projects[dir];
                const began = previous?.status === "red" ? (previous.since ?? previous.at) : undefined;
                // A red extending a red keeps the streak's start; the first red starts it; green ends it.
                const since = status === "red" ? (began ?? at) : undefined;
                const streak = since ?? began;
                verdict = { ...judged(previous, status, failures), ...(streak === undefined ? {} : { since: streak }) };
                const outcome: Outcome = {
                    status,
                    attempt: verdict.attempt,
                    at,
                    ...(failures === undefined ? {} : { failures: [...failures] }),
                    ...(since === undefined ? {} : { since }),
                };
                return { ...current, projects: { ...current.projects, [dir]: outcome } };
            });
            return verdict;
        },
        read: async () => {
            const { projects, runs } = await file.read();
            return { projects, runs };
        },
        noteRun: async (run) => {
            await update((current) => {
                const waiting = (current.lands[run.project] ?? []).filter((land) => !run.lands.some((answered) => sameLand(land, answered)));
                const { [run.project]: _answered, ...others } = current.lands;
                return {
                    ...current,
                    runs: [run, ...current.runs].slice(0, RUNS_KEPT),
                    lands: waiting.length === 0 ? others : { ...others, [run.project]: waiting },
                };
            });
        },
        routed: async (project, at, routing) => {
            await update((current) => {
                const index = current.runs.findIndex((run) => run.project === project && run.at === at);
                if (index === -1) {
                    return current;
                }
                const runs = [...current.runs];
                runs[index] = { ...runs[index]!, routing };
                return { ...current, runs };
            });
        },
        blamed: async (project, ats, blame) => {
            await update((current) => ({
                ...current,
                runs: current.runs.map((run) => {
                    if (run.project !== project || !ats.includes(run.at)) {
                        return run;
                    }
                    const { suspects: _before, ...rest } = run;
                    return { ...rest, named: blame.named, ...(blame.suspects.length === 0 ? {} : { suspects: [...blame.suspects] }) };
                }),
            }));
        },
        owe: async (dirs, land) => {
            await update((current) => {
                const lands = { ...current.lands };
                for (const dir of dirs) {
                    const waiting = lands[dir] ?? [];
                    lands[dir] = waiting.some((queued) => queued.agentId === land.agentId && queued.at === land.at) ? waiting : [...waiting, land];
                }
                return { ...current, lands };
            });
        },
        lands: async () => (await file.read()).lands,
        streaks: async () => (await file.read()).streaks,
        streak: async (project, change) => {
            await update((current) => {
                const next = change(current.streaks[project]);
                const { [project]: _previous, ...others } = current.streaks;
                return { ...current, streaks: next === undefined ? others : { ...others, [project]: next } };
            });
        },
    };
};

export const fileVerifyStore = (path: string): VerifyStore =>
    verifyStoreOver(
        jsonFile<VerifyState>(path, {
            parse: objectParse(VerifyStateSchema),
            fallback: () => ({ projects: {}, runs: [], lands: {}, streaks: {} }),
            document: verifyDocument,
        }),
    );

