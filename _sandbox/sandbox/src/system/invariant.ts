import type { InvariantCheck } from "../invariants/invariants.js";
import { claimHolder, type ContainerRole, type DaemonRoots } from "./boot/container-owner.js";
import { processIdentity, type ProcessIdentity } from "./resources/proc-stat.js";

// Re-checks at runtime whether the boot-time container claim (container-owner.ts) still holds: HOME convergence, the
// leftover sweep, and every singleton trust that one-time answer forever. The claim is a file a second daemon's boot
// can overwrite, so it can go stale while the original daemon keeps acting on it.

export interface ContainerClaimDeps {
    readonly role: ContainerRole;
    readonly roots: DaemonRoots;
    // Overridden only by tests; production reads the process's real HOME, where the claim lives.
    readonly home?: string;
    readonly identity?: ProcessIdentity;
}

export const owner = "platform";

export const checks = ({ role, roots, home, identity = processIdentity() }: ContainerClaimDeps): readonly InvariantCheck[] => [
    {
        name: "container-claim-matches-role",
        // Boot too, not only the sweep: a claim taken during startup is the tightest race there is.
        on: ["boot", "sweep"],
        run: ({ fail }) => {
            const held = claimHolder(home);
            if (role.container) {
                if (identity === undefined) {
                    return fail("this daemon holds the container role but its procfs identity is unavailable");
                }
                if (held === undefined) {
                    return fail(
                        `this daemon (pid ${identity.pid}) holds the container role but the claim file is gone: it is converging HOME and sweeping processes with nothing recording that it owns them`,
                    );
                }
                if (held.pid !== identity.pid || held.startTimeTicks !== identity.startTimeTicks) {
                    return fail(
                        `this daemon (pid ${identity.pid}) holds the container role but the claim now names process ${held.pid}:${held.startTimeTicks} (workspace ${held.workspaceRoot}, history ${held.historyRoot}): two daemons are converging one HOME`,
                    );
                }
                return;
            }
            // A guest holding the claim locks the real daemon out of its own box: the next boot reads it as taken.
            if (identity !== undefined && held?.pid === identity.pid && held.startTimeTicks === identity.startTimeTicks) {
                fail(
                    `this daemon (pid ${identity.pid}) is running as a guest but holds the container claim: the sandbox's own daemon will refuse to converge behind it`,
                );
            }
            // A guest on other roots, or on ours but not the holder (a settled restart), needs no complaint.
            void roots;
        },
    },
];
