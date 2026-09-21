import { streamAgent } from "../agent/routes/agent.routes.js";
import { queueWhole } from "../agent/tools/agent-terminals.js";
import { emitWorkspaceEvent } from "../automations/workspace-events.js";
import type { Services } from "../composition.js";
import type { DependencyOrigin } from "../workspace/deps/dependency-origin.js";
import { queueVerify, type VerifyDeps } from "../workspace/deps/verify-deps.js";
import { announceUnwatchedWrite, subscribeWorkspaceChanges } from "../workspace/watch/workspace-watch.js";

// What the daemon does around a dependency install the coordinator decided on: an activity entry naming who is behind
// and why, and a queued verify that repairs the installed tree. Wired before the data gate opens, though the watcher
// itself starts later: registering now means a turn arriving the instant boot finishes queues behind an already
// reserved repair, instead of racing to discover the stale tree.

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

// The optional fields an activity entry carries when the install can be attributed to a conversation.
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
        emit: (event) => emitWorkspaceEvent(services, event, streamAgent),
        announce: announceUnwatchedWrite,
        queue: queueWhole(services.heavyCommands.read),
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
};
