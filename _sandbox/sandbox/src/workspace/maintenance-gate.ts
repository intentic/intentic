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
 * A READER THAT IS NOT READING GIVES THE TREE BACK (`park`). The gate's premise is that a turn holds its slot
 * only as long as it might run something against the tree — and one turn breaks that on its own: a supervising
 * turn parked on `wait` (agent/subagent-wait.ts) executes nothing for up to half an hour while it sleeps on
 * another agent. Holding through that would let one parked turn stall every dependency repair, and — because
 * writers have priority once queued — every turn that arrived after the repair did. Worse, the agent it sleeps
 * on is the likeliest cause of the repair, so the wait would routinely block the very work it waits for.
 * Parking returns the slot and takes it again before the turn resumes, which is also the honest contract: what
 * a parked turn wakes to is a tree its sibling may have changed. */

export interface TurnLease {
    /* Give the workspace back for the duration of `run` — for a turn parked on something outside the tree —
     * and take it again before returning. A turn stopped while parked comes back holding nothing, so its
     * `release` becomes a no-op rather than dropping a slot it no longer owns. */
    readonly park: <T>(run: () => Promise<T>) => Promise<T>;
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

    /* Take a reader slot: immediately when no writer is waiting or running, otherwise queued behind it. Split
     * out from `enterTurn` because a park has to take the slot back on exactly these terms — the same
     * writer-priority rule, and the same abort. */
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
                park: async (run) => {
                    if (!held) {
                        return run();
                    }
                    held = false;
                    releaseTurn();
                    try {
                        return await run();
                    } finally {
                        // Re-take on the way out, so the turn resumes owning the tree again. A turn stopped
                        // under the park cannot take it back and does not need to: it holds nothing, and the
                        // release in its own finally knows that.
                        await acquire(signal).then(
                            () => {
                                held = true;
                            },
                            () => {},
                        );
                    }
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
