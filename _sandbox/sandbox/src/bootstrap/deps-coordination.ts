import { queueWhole } from "../agent/tools/agent-terminals.js";
import type { Services } from "../composition.js";
import type { DependencyOrigin } from "../workspace/deps/dependency-origin.js";
import { queueVerify, type VerifyDeps } from "../workspace/deps/verify-deps.js";
import { adoptedLandCheck } from "../rules/repo-checks.js";
import { breakageRunSettled, breakageSettled, routeLandBreakage } from "../agents/land/land-breakage.js";
import { announceUnwatchedWrite, subscribeWorkspaceChanges } from "../workspace/watch/workspace-watch.js";

// Wired before the data gate opens, so a turn arriving as boot finishes queues behind an already reserved repair.

const conversationOf = (origin: DependencyOrigin): string | undefined =>
    origin.kind === "land" ? origin.agentId : origin.kind === "request" ? origin.conversationId : undefined;

const titleOf = (origin: DependencyOrigin): string | undefined => (origin.kind === "land" || origin.kind === "request" ? origin.title : undefined);

const reasonOf = (origin: DependencyOrigin): string => {
    if (origin.kind === "land") {
        return "changes from this conversation left the installed tree behind";
    }
    if (origin.kind === "request") {
        return origin.conversationId === undefined ? "setup was requested outside a conversation" : "setup was requested from this conversation";
    }
    if (origin.kind === "startup") {
        return "the daemon found the installed tree behind during startup";
    }
    return "a workspace change left the installed tree behind";
};

const attribution = (origin: DependencyOrigin): { conversationId?: string; title?: string } => {
    const conversationId = conversationOf(origin);
    const title = titleOf(origin);
    return { ...(conversationId === undefined ? {} : { conversationId }), ...(title === undefined ? {} : { title }) };
};

export const wireDependencyCoordinator = (services: Services): void => {
    const dependencyChecks: VerifyDeps = {
        workspace: services.workspace,
        processes: services.processes,
        logger: services.logger,
        verifyStore: services.verifyStore,
        activity: services.activity,
        emit: (event) => services.events.publish("workspace", event),
        announce: announceUnwatchedWrite,
        queue: queueWhole(services.heavyCommands.read),
        route: (breakage) => routeLandBreakage(services, breakage),
        settled: (project) => breakageSettled(services, project),
        recheckPushes: (project) => services.pushChecks.recheckIfOpen(project),
        landCheck: async (dir) => adoptedLandCheck(services.workspace.root, dir, (await services.sandboxSettings.get()).adoptedChecks),
    };
    services.dependencies.subscribe(({ dir, origin }) => {
        const named = dir === "" ? `the workspace root` : dir;
        void services.activity
            .append({
                direction: "system",
                type: "deps.install_started",
                content: `Installing dependencies for ${named}, ${reasonOf(origin)}.`,
                outcome: "ok",
                ...attribution(origin),
            })
            .catch((error: unknown) => services.logger.warn({ err: error }, "dependency coordinator: activity append failed"));
        queueVerify(dependencyChecks, origin, [dir]);
    });
    services.dependencies.subscribeFailures(({ dir, origin }) => {
        const named = dir === "" ? `the workspace root` : dir;
        void services.activity
            .append({
                direction: "system",
                type: "deps.install_failed",
                content: `Dependency installation for ${named} could not start. The project remains behind and will retry on the next readiness check.`,
                outcome: "error",
                ...attribution(origin),
            })
            .catch((error: unknown) => services.logger.warn({ err: error }, "dependency coordinator: failure activity append failed"));
    });
    services.dependencies.watch(subscribeWorkspaceChanges);
    // A red main-line check held on a conversation still working is routed when that conversation's run ends.
    services.events.subscribe("run.settled", ({ conversationId }) => breakageRunSettled(services, conversationId));
};
