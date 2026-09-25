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

// The daemon's one land check (composition.ts), wired to everything it hands work to. Built on first use, since the
// router it hands a red run to reads the finished services.
export const landCheckOf = (services: () => Services): LandCheck => {
    let built: LandCheck | undefined;
    const check = (): LandCheck => {
        if (built !== undefined) {
            return built;
        }
        const all = services();
        built = createLandCheck({
            workspace: all.workspace,
            processes: all.processes,
            logger: all.logger,
            verifyStore: all.verifyStore,
            activity: all.activity,
            emit: (event) => all.events.publish("workspace", event),
            announce: announceUnwatchedWrite,
            heavyPrefix: queuePrefixFor(all.heavyCommands.read),
            // Where the owner sends the check after landing (settings `offload.landCheck`); read per run, so a change binds
            // on the next land.
            offload: async () => (offloadRunEnabled() ? (await all.sandboxSettings.get()).offload.landCheck : undefined),
            route: (breakage) => routeLandBreakage(all, breakage),
            settled: (project, redSince) => breakageSettled(all, project, redSince),
            recheckPushes: (project) => all.pushChecks.recheckIfOpen(project),
            declaredCheck: async (dir) => adoptedLandCheck(all.workspace.root, dir, (await all.sandboxSettings.get()).adoptedChecks),
        });
        return built;
    };
    return {
        enqueue: (origin, dirs) => check().enqueue(origin, dirs),
        current: () => check().current(),
        ahead: (dir) => check().ahead(dir),
        resume: () => check().resume(),
    };
};

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
