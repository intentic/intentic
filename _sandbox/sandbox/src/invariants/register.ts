import { checks as agentChecks, owner as agentOwner, type TurnJournalDeps } from "../agent/invariant.js";
import { checks as agentsChecks, owner as agentsOwner, type FleetRegistryDeps } from "../agents/invariant.js";
import { checks as capabilityChecks, owner as capabilityOwner, type ManifestSecretDeps } from "../capabilities/invariant.js";
import { checks as exitChecks, type ExitInvariantDeps, owner as exitOwner } from "../exit/invariant.js";
import type { InvariantRegistry } from "./invariants.js";

/* WHERE THE COMPANIONS ARE WIRED, the one list, so a companion that is written and never registered is a file
 * nobody runs, and the gate can say so by reading this.
 *
 * The container-claim companion (platform/invariant.ts) is deliberately NOT here: its subject is the role this
 * process took, which main.ts learns AFTER the services are built, so main registers it at the moment it has an
 * answer. Everything whose subject is a service belongs to whoever built the service.
 */

export type DaemonInvariantDeps = TurnJournalDeps & FleetRegistryDeps & ManifestSecretDeps & ExitInvariantDeps;

export const registerDaemonInvariants = (registry: InvariantRegistry, deps: DaemonInvariantDeps): void => {
    registry.register(agentOwner, agentChecks(deps));
    registry.register(agentsOwner, agentsChecks(deps));
    registry.register(capabilityOwner, capabilityChecks(deps));
    registry.register(exitOwner, exitChecks(deps));
};
