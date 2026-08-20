import { z } from "zod";
import { jsonFile } from "../store/json-file.js";
import { objectParse } from "../store/unknown-keys.js";

/* The dependency verifier's memory (<workspace>/.intentic/records/verify.json): the last check outcome per project,
 * and how many consecutive reds it is into. What this buys, across daemon restarts:
 *
 * - `deps.fixed` is an EDGE, and an edge needs the previous colour, green after red is news, green after
 *   green is a tree doing its job (ci-store's conclusions memory, one layer down the stack).
 * - `attempt` is what lets a fix chore's guard cap itself in one visible line of shell. It counts POST-LAND
 *   red verdicts since the last green: the first breakage is attempt 1, a fix that lands and still fails is
 *   attempt 2, and a guard reading `attempt <= 2` stops the loop there, in the automation row where the
 *   owner can see and change it, not in a constant here.
 * - `red()` is the closure re-check's worklist: a land that touches a red project re-runs its checks even
 *   with no dependency drift, which is how a source-only fix ever turns the light green again.
 *
 * Keyed by project dir like workspace-setup's statuses, "" is the workspace root owning the manifest. No
 * pruning: the key space is the workspace's project count, bounded by the same walk that discovers them. */

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

// What one recorded verdict means for whoever must announce it. `attempt` is the value the event carries,
// already advanced for a red, reset for a green.
export interface RecordedVerdict {
    // "broken" on every red (each is caused by exactly one land, so it is fresh news each time, not a poll of
    // a standing state); "fixed" only on the green→red→green edge. undefined: green after green or first-ever
    // green, a tree doing its job announces nothing.
    readonly edge: "broken" | "fixed" | undefined;
    readonly attempt: number;
}

export interface VerifyStore {
    // Project dirs whose last verdict was red, the closure re-check's worklist.
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
