import { startRuntimeHealth } from "../agent/providers/adapter-health.js";
import { adoptBackgroundJobs } from "../agent/tools/background-adoption.js";
import { type ChildReportDeps, reportChildTurn } from "../agent/subagents/child-report.js";
import { conversationProfile } from "../agents/registry/agents-store.js";
import { startVerifyNudges } from "../agent/verification/verify-nudge.js";
import { startWatchers } from "../agent/verification/watchers.js";
import { approvalsExecutorFor } from "../approvals/approvals-executor.js";
import { createAutomationsScheduler } from "../automations/scheduler.js";
import { createCiPoller } from "../ci/poller.js";
import { prepushCheck } from "../prepush/prepush.js";
import type { BootPhase } from "./boot-phase.js";

// Each scheduler registers its stop whether or not this role starts it, so every role unwinds cleanly.
export const startBootSchedulers = ({ role, services, logger, shutdown }: BootPhase): void => {
    const scheduler = createAutomationsScheduler(services);
    shutdown.push(() => scheduler.stop());
    if (role.container) {
        scheduler.start();
    }

    // Stop clears timers only; the watch journal survives for the next boot to restore.
    shutdown.push(startWatchers(services));

    // A turn ending is the moment its background jobs become nobody's: each still running is handed to a watch of its
    // own, so the conversation is woken when it exits. Beside the watchers because it arms one, and after them because
    // it needs their runtime bound.
    shutdown.push(services.events.subscribe("run.settled", (settled) => adoptBackgroundJobs(services.conversations, settled.conversationId, logger)));

    // A spawned child's settled turn is its parent's news, delivered like a wake unless a parked `wait` took it.
    const childReports: ChildReportDeps = {
        doors: { turns: services.turns, sessionIdOf: (conversationId) => services.conversations.sessionIdOf(conversationId) },
        logger,
        conversations: services.conversations,
        entryOf: (conversationId) => services.agents.entry(conversationId),
        profileOf: (conversationId) => {
            const entry = services.agents.entry(conversationId);
            return entry === undefined ? undefined : conversationProfile(entry);
        },
    };
    shutdown.push(services.events.subscribe("run.settled", (settled) => reportChildTurn(childReports, settled)));

    // For runtimes with no SDK Stop hook: the follow-up turn it starts goes through the TurnStarter port.
    shutdown.push(startVerifyNudges(services));

    // Armed, not polled: the deadline is the item's own scheduledAt on disk, so dropping the timer loses nothing.
    const approvalsExecutor = approvalsExecutorFor(services);
    shutdown.push(() => approvalsExecutor.stop());
    // A pre-push suite left alone at exit burns CPU with nothing to report to.
    shutdown.push(() => prepushCheck(services).cancel());
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
    services.history.start();
};
