import { queuePrefixFor } from "../../agent/tools/agent-terminals.js";
import { offloadRunEnabled } from "../../offload/offload-prefix.js";
import type { Services } from "../../composition.js";
import type { DependencyLandOrigin } from "../../workspace/deps/dependency-origin.js";
import type { ReconcileOutcome } from "../../workspace/deps/reconcile-deps.js";
import { createLandCheck, type LandCheck } from "../../workspace/deps/verify-deps.js";
import { breakageSettled, routeLandBreakage } from "./land-breakage.js";
import { adoptedLandCheck } from "../../rules/repo-checks.js";
import { announceUnwatchedWrite } from "../../workspace/watch/workspace-watch.js";

// Every land that reached the tree gets the whole repository's check, whichever door it came through: the auto-land
// that ends a turn or the Land button. When the land left node_modules behind, the reconciler's install listener
// queues the check after the install; otherwise it is queued here, at once.

export interface LandCheckWiring
    extends Pick<
        Services,
        "workspace" | "processes" | "logger" | "verifyStore" | "activity" | "events" | "heavyCommands" | "sandboxSettings" | "pushChecks" | "agents"
    > {
    // The breakage router may start a fix-up conversation, which reaches most of the daemon, so it reads the finished
    // services once per red run; nothing else here waits for composing to end.
    readonly whole: () => Services;
}

// The daemon's one land check (composition.ts), wired to everything it hands work to.
export const landCheckOf = (wiring: LandCheckWiring): LandCheck =>
    createLandCheck({
        workspace: wiring.workspace,
        processes: wiring.processes,
        logger: wiring.logger,
        verifyStore: wiring.verifyStore,
        activity: wiring.activity,
        emit: (event) => wiring.events.publish("workspace", event),
        announce: announceUnwatchedWrite,
        heavyPrefix: queuePrefixFor(wiring.heavyCommands.read),
        // Where the owner sends the check after landing (settings `offload.landCheck`); read per run, so a change binds
        // on the next land.
        offload: async () => (offloadRunEnabled() ? (await wiring.sandboxSettings.get()).offload.landCheck : undefined),
        route: (breakage) => routeLandBreakage(wiring.whole(), breakage),
        settled: (project, redSince) => breakageSettled(wiring, project, redSince),
        recheckPushes: (project) => wiring.pushChecks.afterLandCheck(project),
        declaredCheck: async (dir) => adoptedLandCheck(wiring.workspace.root, dir, (await wiring.sandboxSettings.get()).adoptedChecks),
    });

export type LandVerifier = Pick<Services, "dependencies" | "landCheck">;

// The check's verdict is announced as a workspace event (deps.broken, deps.fixed) for whatever reacts to it; a red that
// names new failures goes to the breakage router (land-breakage.ts), which decides who is sent them: the conversation
// that landed them, a fresh fix-up, or nobody yet.
export const verifyLandedTree = async (services: LandVerifier, origin: DependencyLandOrigin): Promise<ReconcileOutcome | undefined> => {
    const deps = await services.dependencies.reconcileLand(origin);
    if (deps?.deferred !== true) {
        services.landCheck.enqueue(
            origin,
            origin.repos.map(({ repo }) => (repo === "root" ? "" : repo)),
        );
    }
    return deps;
};
