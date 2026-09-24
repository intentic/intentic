import type { AgentJob } from "@intentic/sandbox-contract";

// A job the card no longer carries (a daemon restart forgets them) is `untracked`: nothing is claimed about how it went.

// Who ended a job that did not exit by itself.
export type JobStopper = NonNullable<AgentJob["stoppedBy"]>;

// A running job carries what its turn's ending decided (`handed`: left running for the person, on `ports`), or that a
// stop is under way (`stopping`); each only when it holds.
export type JobPhase =
    | {
          readonly kind: "running";
          readonly startedAt: number;
          readonly session: string;
          readonly handed?: true;
          readonly ports?: readonly number[];
          readonly stopping?: JobStopper;
      }
    // Ended by somebody rather than by itself: the sandbox at its turn's end, a person, or the agent.
    | { readonly kind: "stopped"; readonly by: JobStopper; readonly took: readonly [number, number] }
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
        return {
            kind: `running`,
            startedAt: live.startedAt,
            session: live.session,
            ...(live.handed === true ? { handed: true as const } : {}),
            ...(live.ports === undefined || live.ports.length === 0 ? {} : { ports: live.ports }),
            ...(live.stoppedBy === undefined ? {} : { stopping: live.stoppedBy }),
        };
    }
    const took = [live.startedAt, live.endedAt] as const;
    if (live.stoppedBy !== undefined) {
        return { kind: `stopped`, by: live.stoppedBy, took };
    }
    if (live.exitCode === undefined) {
        return { kind: `ended`, took };
    }
    return live.exitCode === 0 ? { kind: `finished`, took } : { kind: `failed`, exitCode: live.exitCode, took };
};

/** Where a server listens, as a person writes it: `:5173`, or `:5173, :5174`. */
export const portsLine = (ports: readonly number[]): string => ports.map((port) => `:${String(port)}`).join(`, `);

/** The conversation's jobs still running, oldest first. */
export const runningJobs = (jobs: readonly AgentJob[] | undefined): readonly AgentJob[] =>
    (jobs ?? []).filter((job) => job.endedAt === undefined).toSorted((left, right) => left.startedAt - right.startedAt);
