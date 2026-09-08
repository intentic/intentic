import type { WorkspaceEvent } from "@intentic/sandbox-contract";
import { queueWhole } from "../../agent/tools/agent-terminals.js";
import type { Services } from "../../composition.js";
import type { DependencyLandOrigin } from "../../workspace/deps/dependency-origin.js";
import type { ReconcileOutcome } from "../../workspace/deps/reconcile-deps.js";
import { queueVerify, type VerifyDeps } from "../../workspace/deps/verify-deps.js";

// Every land that reached the tree gets the whole repository's check, whichever door it came through: the auto-land
// that ends a turn or the Land button. When the land left node_modules behind, the reconciler's install listener
// queues the check after the install; otherwise it is queued here, at once.

export type LandVerifier = Pick<Services, "workspace" | "processes" | "logger" | "verifyStore" | "activity" | "heavyCommands" | "dependencies">;

export const verifyLandedTree = async (
    services: LandVerifier,
    emit: (event: WorkspaceEvent) => void,
    origin: DependencyLandOrigin,
): Promise<ReconcileOutcome | undefined> => {
    const verifier: VerifyDeps = {
        workspace: services.workspace,
        processes: services.processes,
        logger: services.logger,
        verifyStore: services.verifyStore,
        activity: services.activity,
        emit,
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
