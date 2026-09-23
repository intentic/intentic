import { queueWhole } from "../../agent/tools/agent-terminals.js";
import type { Services } from "../../composition.js";
import type { DependencyLandOrigin } from "../../workspace/deps/dependency-origin.js";
import type { ReconcileOutcome } from "../../workspace/deps/reconcile-deps.js";
import { queueVerify, type VerifyDeps } from "../../workspace/deps/verify-deps.js";
import { announceUnwatchedWrite } from "../../workspace/watch/workspace-watch.js";

// Every land that reached the tree gets the whole repository's check, whichever door it came through: the auto-land
// that ends a turn or the Land button. When the land left node_modules behind, the reconciler's install listener
// queues the check after the install; otherwise it is queued here, at once.

export type LandVerifier = Pick<
    Services,
    "workspace" | "processes" | "logger" | "verifyStore" | "activity" | "heavyCommands" | "dependencies" | "events"
>;

// The check's verdict is announced as a workspace event (deps.broken, deps.fixed) for whatever reacts to it.
export const verifyLandedTree = async (services: LandVerifier, origin: DependencyLandOrigin): Promise<ReconcileOutcome | undefined> => {
    const verifier: VerifyDeps = {
        workspace: services.workspace,
        processes: services.processes,
        logger: services.logger,
        verifyStore: services.verifyStore,
        activity: services.activity,
        emit: (event) => services.events.publish("workspace", event),
        announce: announceUnwatchedWrite,
        queue: queueWhole(services.heavyCommands.read),
    };
    const deps = await services.dependencies.reconcileLand(origin);
    if (deps?.deferred !== true) {
        queueVerify(
            verifier,
            origin,
            origin.repos.map(({ repo }) => (repo === "root" ? "" : repo)),
        );
    }
    return deps;
};
