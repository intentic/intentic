import { startRuntimeHealth } from "../agent/providers/adapter-health.js";
import { type ChildReportDeps, reportChildTurn } from "../agent/subagents/child-report.js";
import { childKillNote } from "../agent/subagents/children.js";
import { conversationProfile } from "../conversations/registry/agents-store.js";
import { startWatchers } from "../agent/verification/watchers.js";
import { approvalsExecutorFor } from "../approvals/approvals-executor.js";
import { createAutomationsScheduler } from "../automations/scheduler.js";
import { createCiPoller } from "../ci/poller.js";
import { autoKeepWarm, createKeepWarmScheduler } from "../agent/run/turn/cache-keepwarm.js";
import type { BootPhase } from "./boot-phase.js";
import { subscribeRepoChanges } from "../workspace/watch/repo-watch.js";
import { subscribeUnwatchedWrites, subscribeWorkspaceChanges } from "../workspace/watch/workspace-watch.js";

// Each scheduler registers its stop whether or not this role starts it, so every role unwinds cleanly.
export const startBootSchedulers = ({ role, services, logger, shutdown }: BootPhase): void => {
    const scheduler = createAutomationsScheduler(services);
    shutdown.push(() => scheduler.stop());
    if (role.container) {
        scheduler.start();
    }

    // Stop clears timers only; the watch journal survives for the next boot to restore. What a turn left running is
    // judged and handed to a watch by the turn's own close (agent/run/placement/turn-close.ts), which needs this bound.
    shutdown.push(startWatchers(services));

    // A spawned child's settled turn is its parent's news, delivered like a wake unless a parked `wait` took it.
    const childReports: ChildReportDeps = {
        doors: { turns: services.turns, sessionIdOf: (conversationId) => services.conversations.sessionIdOf(conversationId) },
        logger,
        conversations: services.conversations,
        entryOf: (conversationId) => {
            const entry = services.agents.entry(conversationId);
            return entry === undefined ? undefined : { startedBy: entry.identity.startedBy, title: entry.social.title?.text };
        },
        profileOf: (conversationId) => {
            const entry = services.agents.entry(conversationId);
            return entry === undefined ? undefined : conversationProfile(entry);
        },
        killNote: (childId, failure) => childKillNote(services, childId, failure),
    };
    shutdown.push(services.events.subscribe("run.settled", (settled) => reportChildTurn(childReports, settled)));

    // Refreshes idle conversations' prompt caches; a settled turn a person asked for arms one where the setting says so.
    const keepWarm = createKeepWarmScheduler(services);
    shutdown.push(() => keepWarm.stop());
    if (role.container) {
        keepWarm.start();
        shutdown.push(services.events.subscribe("run.settled", (settled) => autoKeepWarm(services, settled)));
    }

    // Armed, not polled: the deadline is the item's own scheduledAt on disk, so dropping the timer loses nothing.
    const approvalsExecutor = approvalsExecutorFor(services);
    shutdown.push(() => approvalsExecutor.stop());
    if (role.container) {
        void approvalsExecutor.arm().catch((error: unknown) => logger.warn({ err: error }, "approvals executor not armed"));
    }

    if (role.container) {
        services.ciHooks.start();
    }

    // Covers repos whose CI hook could not be registered; its first pass is a silent seed.
    const ciPoller = createCiPoller(services);
    shutdown.push(() => ciPoller.stop());
    if (role.container) {
        ciPoller.start();
    }

    if (role.container) {
        // Both idle-only, allowed to fail, unref'd; the probe runner also waits out the boot's own pnpm install.
        services.probeRunner.start();
        services.driftSweep.start();
    }

    startRuntimeHealth(services);
    // Idle backstop: headroom is otherwise re-read only on a turn, refusal or screen.
    services.headroom.start();
    // Anything the watchers see, a repo appearing or going, or a write the daemon made where no watcher looks.
    services.history.start((changed) => {
        const stops = [subscribeWorkspaceChanges(changed), subscribeRepoChanges(changed), subscribeUnwatchedWrites(changed)];
        return () => {
            for (const stop of stops) {
                stop();
            }
        };
    });
};
