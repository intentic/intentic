/* A workspace-wide readers/writer gate.
 *
 * Agent turns are readers: many may work at once. Dependency installation is the writer: it rewrites the
 * dependency tree every isolated turn mounts. A last-second `liveSessionIds()` check cannot enforce that
 * boundary because a turn may start immediately after the check. This gate makes admission and maintenance
 * one atomic decision instead.
 *
 * Writers have priority once queued. Without that, a steady stream of turns could keep a dependency install
 * waiting forever; with it, turns already running finish normally and later turns wait for the visible
 * maintenance job to settle.
 *
 * CHECKS are the third mode, and they are neither. The post-install verification (verify-deps.ts) runs the
 * project's own test suite — minutes on a real repo — and it used to run as a writer, which held every new
 * message out of the workspace for its whole length: a user watched their turn sit "waiting for dependency
 * setup" while the daemon ran typecheck-and-test. A check only READS the tree, so what it needs is exactly a
 * reader's guarantee (no install rewrites the tree beneath it) plus a quiet start (a verdict taken over
 * somebody's half-written edit would be noise announced as fact). So a check STARTS only when the gate is
 * fully idle — no turn running, none waiting — and then holds an ordinary reader slot: installs queue behind
 * it, and a turn arriving mid-check walks straight in. The turn may make the verdict stale; a stale advisory
 * verdict costs a re-run, where the old arrangement cost every user minutes of their turn.
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
    readonly runChecks: <T>(run: () => Promise<T>) => Promise<T>;
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
    const checks: Array<() => void> = [];

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
        // A check starts only into full quiet — turns that were waiting above have just been admitted, so
        // `turns` being zero here means nobody was running AND nobody was queued. It then occupies an ordinary
        // reader slot: a later install queues behind it, and a later turn is admitted beside it (acquire's
        // fast path — no writer is waiting). One check at a time falls out of the same arithmetic.
        if (turns === 0) {
            const check = checks.shift();
            if (check !== undefined) {
                turns += 1;
                check();
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
        runChecks: async (run) => {
            await new Promise<void>((resolve) => {
                checks.push(resolve);
                drain();
            });
            try {
                return await run();
            } finally {
                releaseTurn();
            }
        },
    };
};
