import { z } from "zod";
import { jsonFile } from "../../store/json-file.js";
import { objectParse } from "../../store/unknown-keys.js";

// Dependency verifier's memory (<workspace>/.intentic/records/verify.json): last check outcome per project and its
// consecutive red streak, across restarts.
// - deps.fixed is an edge: green after red is news, green after green isn't.
// - attempt counts post-land reds since the last green, for a fix guard to cap on.
// - red() is the closure re-check's worklist.
// - failures are the last verdict's units, so the next red names only what appeared since.

const OutcomeSchema = z.object({
    status: z.enum(["green", "red"]),
    // Consecutive red verdicts since the last green; 0 while green.
    attempt: z.number(),
    at: z.number(),
    // What the check failed on, as its own report named it; absent when it wrote none.
    failures: z.array(z.string()).optional(),
});
const VerifyStateSchema = z.object({
    projects: z.record(z.string(), OutcomeSchema),
});
type VerifyState = z.infer<typeof VerifyStateSchema>;

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
        fallback: () => ({ projects: {} }),
    });
    return {
        red: async () =>
            Object.entries((await file.read()).projects)
                .filter(([, outcome]) => outcome.status === "red")
                .map(([dir]) => dir),
        record: async (dir, status, at, failures) => {
            let verdict: RecordedVerdict = { edge: undefined, attempt: 0 };
            await file.update((current) => {
                verdict = judged(current.projects[dir], status, failures);
                const outcome: Outcome = { status, attempt: verdict.attempt, at, ...(failures === undefined ? {} : { failures: [...failures] }) };
                return { projects: { ...current.projects, [dir]: outcome } };
            });
            return verdict;
        },
    };
};
