import { checks as agentChecks, owner as agentOwner, type TurnJournalDeps } from "../agent/invariant.js";
import { checks as agentsChecks, owner as agentsOwner, type FleetRegistryDeps } from "../agents/invariant.js";
import { checks as capabilityChecks, owner as capabilityOwner, type ManifestSecretDeps } from "../capabilities/invariant.js";
import { checks as childrenChecks, owner as childrenOwner } from "../agent/subagents/invariant.js";
import { checks as cursorChecks, type CommandGateDeps, owner as cursorOwner } from "../runtimes/cursor/invariant.js";
import { checks as dependenciesChecks, owner as dependenciesOwner } from "../dependencies/invariant.js";
import { checks as derivedChecks, owner as derivedOwner } from "../derived/invariant.js";
import { checks as engineChecks, owner as engineOwner } from "../engines/invariant.js";
import { checks as exitChecks, type ExitInvariantDeps, owner as exitOwner } from "../exit/invariant.js";
import { checks as issueChecks, type IssuesInboxDeps, owner as issueOwner } from "../issues/invariant.js";
import { checks as hostChecks, owner as hostOwner } from "../hosts/invariant.js";
import { checks as peerChecks, owner as peerOwner, type PeerRegistryDeps } from "../peers/invariant.js";
import { checks as runnerChecks, owner as runnerOwner } from "../runners/invariant.js";
import { checks as fenceChecks, owner as fenceOwner } from "../fences/invariant.js";
import { checks as runtimeChecks, owner as runtimeOwner } from "../runtimes/invariant.js";
import { checks as tunnelChecks, owner as tunnelOwner } from "../tunnel/invariant.js";
import { checks as webextChecks, owner as webextOwner } from "../webext/invariant.js";
import type { InvariantRegistry } from "./invariants.js";

// The one list wiring invariant companions to the registry, so an unregistered companion is visible to the gate.
// platform/invariant.ts is excluded (main.ts registers it once it knows this process's role); a companion with no
// checks is still registered, since owners() means "answered", not "has checks".

export type DaemonInvariantDeps = TurnJournalDeps &
    FleetRegistryDeps &
    ManifestSecretDeps &
    ExitInvariantDeps &
    PeerRegistryDeps &
    IssuesInboxDeps &
    CommandGateDeps;

export const registerDaemonInvariants = (registry: InvariantRegistry, deps: DaemonInvariantDeps): void => {
    registry.register(agentOwner, agentChecks(deps));
    registry.register(agentsOwner, agentsChecks(deps));
    registry.register(capabilityOwner, capabilityChecks(deps));
    registry.register(exitOwner, exitChecks(deps));
    registry.register(peerOwner, peerChecks(deps));
    registry.register(issueOwner, issueChecks(deps));
    registry.register(cursorOwner, cursorChecks(deps));
    // Read their subjects off module state and the volume rather than off a service.
    registry.register(childrenOwner, childrenChecks());
    registry.register(hostOwner, hostChecks());
    registry.register(webextOwner, webextChecks());
    registry.register(runnerOwner, runnerChecks());
    registry.register(engineOwner, engineChecks());
    registry.register(dependenciesOwner, dependenciesChecks());
    registry.register(derivedOwner, derivedChecks());
    registry.register(fenceOwner, fenceChecks());
    registry.register(runtimeOwner, runtimeChecks());
    registry.register(tunnelOwner, tunnelChecks());
};
