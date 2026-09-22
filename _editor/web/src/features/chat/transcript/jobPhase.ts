import type { AgentJob } from "@intentic/sandbox-contract";

// A job the card no longer carries (a daemon restart forgets them) is `untracked`: nothing is claimed about how it went.

export type JobPhase =
    | { readonly kind: "running"; readonly startedAt: number; readonly session: string }
    | { readonly kind: "finished"; readonly took: readonly [number, number] }
    | { readonly kind: "failed"; readonly exitCode: number; readonly took: readonly [number, number] }
    // Exited, and left no code to say how.
    | { readonly kind: "ended"; readonly took: readonly [number, number] }
    | { readonly kind: "untracked" };

export const jobPhase = (live: AgentJob | undefined): JobPhase => {
    if (live === undefined) {
        return { kind: `untracked` };
    }
    if (live.endedAt === undefined) {
        return { kind: `running`, startedAt: live.startedAt, session: live.session };
    }
    const took = [live.startedAt, live.endedAt] as const;
    if (live.exitCode === undefined) {
        return { kind: `ended`, took };
    }
    return live.exitCode === 0 ? { kind: `finished`, took } : { kind: `failed`, exitCode: live.exitCode, took };
};

/** The conversation's jobs still running, oldest first. */
export const runningJobs = (jobs: readonly AgentJob[] | undefined): readonly AgentJob[] =>
    (jobs ?? []).filter((job) => job.endedAt === undefined).toSorted((left, right) => left.startedAt - right.startedAt);
