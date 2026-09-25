import type { Services } from "../composition.js";
import type { DependencyOrigin } from "../workspace/deps/dependency-origin.js";
import { breakageRunSettled, resumeBreakageRouter } from "../agents/land/land-breakage.js";
import { subscribeWorkspaceChanges } from "../workspace/watch/workspace-watch.js";

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
        services.landCheck.enqueue(origin, [dir]);
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
    services.events.subscribe("run.settled", ({ conversationId }) => {
        void breakageRunSettled(services, conversationId).catch((error: unknown) =>
            services.logger.warn({ err: error, conversationId }, "dependency coordinator: a held red could not be released"),
        );
    });
    // What the daemon was doing when it stopped, from the verify store: lands no run answered are queued for a check
    // first, so a red that waited on them keeps waiting, and reds it held or waited on are decided again.
    void (async () => {
        await services.landCheck.resume();
        await resumeBreakageRouter(services);
    })().catch((error: unknown) => services.logger.warn({ err: error }, "dependency coordinator: the main line could not be resumed"));
};
