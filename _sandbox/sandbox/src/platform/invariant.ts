import type { InvariantCheck } from "../invariants/invariants.js";
import { claimHolder, type ContainerRole, type DaemonRoots } from "./container-owner.js";

/* ONE CONTAINER, ONE DAEMON, still true, or no longer true.
 *
 * container-owner.ts asks the question once, at boot, because that is the only moment it can act on the answer:
 * take the container or run as a guest. Everything downstream then trusts that answer forever. Four boot jobs
 * converged HOME on it, the leftover sweep reclaims processes on it, and the singletons with one address, the
 * translator, the platform announce, the scheduler, the drafts publisher, the CI reconciler, each run because
 * of it.
 *
 * The claim is a FILE in a HOME two daemons share, and the second daemon's own boot is what overwrites it. So
 * the answer can stop being true while the daemon that acted on it is still acting on it, and today nothing
 * anywhere would say a word: the log line was written at boot, was correct at boot, and is the last mention.
 * That is the shape of the 2026-07-31 incident, seen from the survivor's side.
 */

export interface ContainerClaimDeps {
    readonly role: ContainerRole;
    readonly roots: DaemonRoots;
    // Overridden only by tests; production reads the process's real HOME, which is where the claim lives.
    readonly home?: string;
    readonly pid?: number;
}

export const owner = "platform";

export const checks = ({ role, roots, home, pid = process.pid }: ContainerClaimDeps): readonly InvariantCheck[] => [
    {
        name: "container-claim-matches-role",
        // Boot too, not only the sweep: a claim taken during our own startup is the tightest race there is, and
        // the first sweep is a minute away.
        on: ["boot", "sweep"],
        run: ({ fail }) => {
            const held = claimHolder(home);
            if (role.container) {
                if (held === undefined) {
                    return fail(
                        `this daemon (pid ${pid}) holds the container role but the claim file is gone: it is converging HOME and sweeping processes with nothing recording that it owns them`,
                    );
                }
                if (held.pid !== pid) {
                    return fail(
                        `this daemon (pid ${pid}) holds the container role but the claim now names pid ${held.pid} (workspace ${held.workspaceRoot}, history ${held.historyRoot}): two daemons are converging one HOME`,
                    );
                }
                return;
            }
            /* The guest's half of the same promise, and the one that actually did the damage: a run that decided
             * it was a guest must not be holding the claim, because holding it is what tells the NEXT daemon the
             * container is taken. A guest whose pid is in that file locks the real sandbox out of its own box. */
            if (held?.pid === pid) {
                fail(
                    `this daemon (pid ${pid}) is running as a guest but holds the container claim: the sandbox's own daemon will refuse to converge behind it`,
                );
            }
            // A guest on OTHER roots is ordinary and expected. A guest on OUR roots that is not the holder is
            // the restart case, already settled by then. Neither is worth a word.
            void roots;
        },
    },
];
