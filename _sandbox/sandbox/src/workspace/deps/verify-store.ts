import { type MainlineRouting, MainlineRunSchema, type MainlineRun } from "@intentic/sandbox-contract";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { jsonFile } from "../../store/json-file.js";
import { objectParse } from "../../store/unknown-keys.js";
import { stateRelPath } from "../../state-paths.js";

// The main-line check's memory (<workspace>/.intentic/records/verify.json): last check outcome per project and its
// consecutive red streak, and the latest runs across every project with what became of each red one, across restarts.
// - deps.fixed is an edge: green after red is news, green after green isn't.
// - attempt counts post-land reds since the last green, for a fix guard to cap on.
// - since is when the red streak began: a fresh fix-up's id is derived from it, so one streak is one failure.
// - red() is the closure re-check's worklist.
// - failures are the last verdict's units, so the next red names only what appeared since.
// - runs is what the editor's strip and every card read (mainline-status.ts), newest first.

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
const VerifyStateSchema = z.object({
    projects: z.record(z.string(), OutcomeSchema),
    // Newest first, bounded; written by the check itself and by whoever decides what a red one's failures are owed.
    runs: z.array(MainlineRunSchema).default([]),
});
type VerifyState = z.infer<typeof VerifyStateSchema>;

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
}

export interface VerifyStore {
    // Project dirs whose last verdict was red; the closure re-check's worklist.
    readonly red: () => Promise<string[]>;
    readonly record: (dir: string, status: "green" | "red", at: number, failures?: readonly string[]) => Promise<RecordedVerdict>;
    // Every project's last outcome and the latest runs, newest first.
    readonly read: () => Promise<{ readonly projects: Readonly<Record<string, VerifyOutcome>>; readonly runs: readonly MainlineRun[] }>;
    // Files one settled run at the head of the history.
    readonly noteRun: (run: MainlineRun) => Promise<void>;
    // What became of a red run's failures, on the run that ended at `at` in `project`; nothing when it has aged out.
    readonly routed: (project: string, at: number, routing: MainlineRouting, suspects?: readonly string[]) => Promise<void>;
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

export const fileVerifyStore = (path: string): VerifyStore => {
    const file = jsonFile<VerifyState>(path, {
        parse: objectParse(VerifyStateSchema),
        fallback: () => ({ projects: {}, runs: [] }),
        document: verifyDocument,
    });
    return {
        red: async () =>
            Object.entries((await file.read()).projects)
                .filter(([, outcome]) => outcome.status === "red")
                .map(([dir]) => dir),
        record: async (dir, status, at, failures) => {
            let verdict: RecordedVerdict = { edge: undefined, attempt: 0 };
            await file.update((current) => {
                const previous = current.projects[dir];
                verdict = judged(previous, status, failures);
                // A red extending a red keeps the streak's start; the first red starts it; green ends it.
                const since = status === "red" ? (previous?.status === "red" ? (previous.since ?? previous.at) : at) : undefined;
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
            await file.update((current) => ({ ...current, runs: [run, ...current.runs].slice(0, RUNS_KEPT) }));
        },
        routed: async (project, at, routing, suspects) => {
            await file.update((current) => {
                const index = current.runs.findIndex((run) => run.project === project && run.at === at);
                if (index === -1) {
                    return current;
                }
                const runs = [...current.runs];
                runs[index] = { ...runs[index]!, routing, ...(suspects === undefined || suspects.length === 0 ? {} : { suspects: [...suspects] }) };
                return { ...current, runs };
            });
        },
    };
};
