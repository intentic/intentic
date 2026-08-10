/* A workspace-wide readers/writer gate.
 *
 * Agent turns are readers: many may work at once. Dependency installation and the checks that follow are
 * writers: they rewrite or rely on the dependency tree every isolated turn mounts. A last-second
 * `liveSessionIds()` check cannot enforce that boundary because a turn may start immediately after the check.
 * This gate makes admission and maintenance one atomic decision instead.
 *
 * Writers have priority once queued. Without that, a steady stream of turns could keep a dependency install
 * waiting forever; with it, turns already running finish normally and later turns wait for the visible
 * maintenance job to settle.
 *
 * A TURN HOLDS ITS SLOT FOR ITS WHOLE LENGTH, including the parts where the model is asleep — parked on a
 * question, on a plan approval, or on `wait` (agent/subagent-wait.ts). This looked worth an exception once, and
 * it is not: what a sleeping turn leaves running against the tree is exactly the thing an install must not run
 * beneath, and `wait` in particular sleeps only while a child of that turn is still working. A turn with
 * nothing of its own left running is a turn that is about to end, and its slot comes back on its own. */

export interface TurnLease {
    readonly release: () => void;
}

export interface WorkspaceMaintenanceGate {
    readonly enterTurn: (signal?: AbortSignal) => Promise<TurnLease>;
    readonly runMaintenance: <T>(run: () => Promise<T>) => Promise<T>;
}

interface TurnWaiter {
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly signal?: AbortSignal;
    readonly aborted: () => void;
}

const abortError = (): Error => Object.assign(new Error("The turn ended while waiting for workspace maintenance."), { name: "AbortError" });

export const createWorkspaceMaintenanceGate = (): WorkspaceMaintenanceGate => {
    let turns = 0;
    let maintaining = false;
    const maintenance: Array<() => void> = [];
    const waitingTurns: TurnWaiter[] = [];

    const releaseTurn = (): void => {
        turns = Math.max(0, turns - 1);
        drain();
    };

    const admitTurn = (waiter: TurnWaiter): void => {
        waiter.signal?.removeEventListener("abort", waiter.aborted);
        turns += 1;
        waiter.resolve();
    };

    // Take a reader slot: immediately when no writer is waiting or running, otherwise queued behind it — and
    // abandoned if the turn is stopped before it is admitted.
    const acquire = (signal?: AbortSignal): Promise<void> => {
        if (signal?.aborted === true) {
            return Promise.reject(abortError());
        }
        if (!maintaining && maintenance.length === 0) {
            turns += 1;
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const waiter: TurnWaiter = {
                resolve,
                reject,
                ...(signal === undefined ? {} : { signal }),
                aborted: () => {
                    const index = waitingTurns.indexOf(waiter);
                    if (index !== -1) {
                        waitingTurns.splice(index, 1);
                    }
                    reject(abortError());
                },
            };
            waitingTurns.push(waiter);
            signal?.addEventListener("abort", waiter.aborted, { once: true });
        });
    };

    const drain = (): void => {
        if (maintaining || turns > 0) {
            return;
        }
        const writer = maintenance.shift();
        if (writer !== undefined) {
            maintaining = true;
            writer();
            return;
        }
        while (waitingTurns.length > 0) {
            const waiter = waitingTurns.shift();
            if (waiter !== undefined && waiter.signal?.aborted !== true) {
                admitTurn(waiter);
            }
        }
    };

    return {
        enterTurn: async (signal) => {
            await acquire(signal);
            let held = true;
            return {
                release: () => {
                    if (!held) {
                        return;
                    }
                    held = false;
                    releaseTurn();
                },
            };
        },
        runMaintenance: async (run) => {
            await new Promise<void>((resolve) => {
                maintenance.push(resolve);
                drain();
            });
            try {
                return await run();
            } finally {
                maintaining = false;
                drain();
            }
        },
    };
};
