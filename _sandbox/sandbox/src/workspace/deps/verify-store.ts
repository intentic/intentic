import { z } from "zod";
import { jsonFile } from "../../store/json-file.js";
import { objectParse } from "../../store/unknown-keys.js";

// Dependency verifier's memory (<workspace>/.intentic/records/verify.json): last check outcome per project and its
// consecutive red streak, across restarts.
// - deps.fixed is an edge: green after red is news, green after green isn't.
// - attempt counts post-land reds since the last green, for a fix guard to cap on.
// - red() is the closure re-check's worklist.

const OutcomeSchema = z.object({
    status: z.enum(["green", "red"]),
    // Consecutive red verdicts since the last green; 0 while green.
    attempt: z.number(),
    at: z.number(),
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
}

export interface VerifyStore {
    // Project dirs whose last verdict was red; the closure re-check's worklist.
    readonly red: () => Promise<string[]>;
    readonly record: (dir: string, status: "green" | "red", at: number) => Promise<RecordedVerdict>;
}

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
        record: async (dir, status, at) => {
            let verdict: RecordedVerdict = { edge: undefined, attempt: 0 };
            await file.update((current) => {
                const previous = current.projects[dir];
                const attempt = status === "red" ? (previous?.status === "red" ? previous.attempt + 1 : 1) : 0;
                verdict = {
                    edge: status === "red" ? "broken" : previous?.status === "red" ? "fixed" : undefined,
                    attempt,
                };
                return { projects: { ...current.projects, [dir]: { status, attempt, at } } };
            });
            return verdict;
        },
    };
};
