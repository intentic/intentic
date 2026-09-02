import { checks as agentChecks, owner as agentOwner, type TurnJournalDeps } from "../agent/invariant.js";
import { checks as agentsChecks, owner as agentsOwner, type FleetRegistryDeps } from "../agents/invariant.js";
import { checks as capabilityChecks, owner as capabilityOwner, type ManifestSecretDeps } from "../capabilities/invariant.js";
import { checks as childrenChecks, owner as childrenOwner } from "../children/invariant.js";
import { checks as cursorChecks, type CommandGateDeps, owner as cursorOwner } from "../cursor/invariant.js";
import { checks as dependenciesChecks, owner as dependenciesOwner } from "../dependencies/invariant.js";
import { checks as derivedChecks, owner as derivedOwner } from "../derived/invariant.js";
import { checks as engineChecks, owner as engineOwner } from "../engines/invariant.js";
import { checks as exitChecks, type ExitInvariantDeps, owner as exitOwner } from "../exit/invariant.js";
import { checks as issueChecks, type IssuesInboxDeps, owner as issueOwner } from "../issues/invariant.js";
import { checks as runnerChecks, owner as runnerOwner, type RunnerRegistryDeps } from "../runners/invariant.js";
import { checks as testingChecks, owner as testingOwner } from "../testing/invariant.js";
import { checks as webextChecks, type BrowserRegistryDeps, owner as webextOwner } from "../webext/invariant.js";
import type { InvariantRegistry } from "./invariants.js";

/* WHERE THE COMPANIONS ARE WIRED, the one list, so a companion that is written and never registered is a file
 * nobody runs, and the gate can say so by reading this.
 *
 * The container-claim companion (platform/invariant.ts) is deliberately NOT here: its subject is the role this
 * process took, which main.ts learns AFTER the services are built, so main registers it at the moment it has an
 * answer. Everything whose subject is a service belongs to whoever built the service.
 *
 * The companions with no checks are registered too. The registry's `owners()` is then the list of subsystems
 * that have ANSWERED, which is the fact the diagnostics surface wants, and the same list the gate reads; a
 * subsystem with nothing to check is an answer, not an absence. */

export type DaemonInvariantDeps = TurnJournalDeps &
    FleetRegistryDeps &
    ManifestSecretDeps &
    ExitInvariantDeps &
    RunnerRegistryDeps &
    BrowserRegistryDeps &
    IssuesInboxDeps &
    CommandGateDeps;

export const registerDaemonInvariants = (registry: InvariantRegistry, deps: DaemonInvariantDeps): void => {
    registry.register(agentOwner, agentChecks(deps));
    registry.register(agentsOwner, agentsChecks(deps));
    registry.register(capabilityOwner, capabilityChecks(deps));
    registry.register(exitOwner, exitChecks(deps));
    registry.register(runnerOwner, runnerChecks(deps));
    registry.register(webextOwner, webextChecks(deps));
    registry.register(issueOwner, issueChecks(deps));
    registry.register(cursorOwner, cursorChecks(deps));
    // Read their subjects off module state and the volume rather than off a service.
    registry.register(childrenOwner, childrenChecks());
    registry.register(engineOwner, engineChecks());
    registry.register(dependenciesOwner, dependenciesChecks());
    registry.register(derivedOwner, derivedChecks());
    registry.register(testingOwner, testingChecks());
};
