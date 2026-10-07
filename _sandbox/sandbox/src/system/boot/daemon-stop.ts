import type { DisposeOutcome } from "@intentic/base/lifecycle";

// How long the daemon's teardown may run before the process exits anyway: well inside the 25 s netd gives a stopping
// daemon before its SIGKILL (netd's supervise.rs STOP_GRACE), so a stop that hangs costs this wait, never the kill.
export const STOP_DEADLINE_MS = 10_000;

// How the daemon exits when netd's control link drops without being asked to: EX_TEMPFAIL. netd starts again a daemon
// that exits with anything but 0 or 78 (its supervise.rs) and goes on running, where a 0 would end netd, and with it the
// container (on Fly, a machine left stopped) for what restarting Node alone recovers.
export const LINK_LOST_EXIT = 75;

// What the daemon tears down on its way out: every subsystem's stop, registered where it was started.
export interface Teardown {
    readonly disposeWithin: (deadlineMs: number) => Promise<DisposeOutcome>;
}

// Runs the teardown, newest first, under STOP_DEADLINE_MS and describes what did not stop cleanly: undefined when
// everything did. Never throws, since an exit follows it whatever happened.
export const tearDown = async (teardown: Teardown): Promise<string | undefined> => {
    const { failed, unfinished } = await teardown.disposeWithin(STOP_DEADLINE_MS);
    const problems = [
        ...failed.map((error) => (error instanceof Error ? error.message : String(error))),
        ...(unfinished > 0 ? [`${unfinished} still stopping after ${STOP_DEADLINE_MS} ms`] : []),
    ];
    return problems.length === 0 ? undefined : problems.join("; ");
};
