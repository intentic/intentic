import type { InvariantCheck } from "../invariants/invariants.js";
import type { RunnerHub } from "./runner-hub.js";
import type { RunnersStore } from "./runners-store.js";

/* A SOCKET THE STORE NO LONGER VOUCHES FOR IS A REVOKED RUNNER STILL RECEIVING WORK.
 *
 * A runner is two records: the enrollment on /history (runners-store.ts, the durable half) and the live
 * socket in memory (runner-hub.ts, the half that dispatches). The store checks the token exactly once, when
 * the socket connects; from then on the hub's map IS the authority, and every dispatched turn and every
 * credential handed down the socket goes to whatever id is in it. Revocation is therefore two calls that
 * nothing ties together: the store forgets the id, and "its live socket is closed by the caller", in the
 * store's own words. A caller that makes the first and not the second (or makes it before the attach that
 * races it) leaves a machine the owner removed holding a socket that still receives this sandbox's turns and
 * provider credentials, until its next reconnect is refused, which for a machine that never sleeps is never. */

export interface RunnerRegistryDeps {
    readonly runners: RunnersStore;
    readonly runnerHub: RunnerHub;
}

export const owner = "runners";

export const checks = ({ runners, runnerHub }: RunnerRegistryDeps): readonly InvariantCheck[] => [
    {
        name: "live-runners-are-enrolled",
        // Not `boot`: the hub is empty then by construction, a socket does not survive a restart.
        on: ["sweep"],
        run: async ({ fail }) => {
            const connected = runnerHub.connected();
            if (connected.length === 0) {
                return;
            }
            const enrolled = new Set((await runners.list()).map((runner) => runner.id));
            const strays = connected.filter((id) => !enrolled.has(id));
            if (strays.length > 0) {
                fail(
                    `${strays.length} runner socket(s) are live for ids the enrollment store does not hold (${strays.join(", ")}): a revoked runner still receiving this sandbox's turns and credentials`,
                );
            }
        },
    },
];
