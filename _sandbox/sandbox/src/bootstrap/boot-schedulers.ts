import { startRuntimeHealth } from "../agent/providers/adapter-health.js";
import { streamAgent } from "../agent/routes/agent.routes.js";
import { startVerifyNudges } from "../agent/verification/verify-nudge.js";
import { startWatchers } from "../agent/verification/watchers.js";
import { approvalsExecutorFor } from "../approvals/approvals-executor.js";
import { createAutomationsScheduler } from "../automations/scheduler.js";
import { createCiPoller } from "../ci/poller.js";
import { prepushCheck } from "../prepush/prepush.js";
import type { BootPhase } from "./boot-phase.js";

// The standing schedulers this daemon arms once boot is past the gate: everything that fires work of its own accord
// between turns. Each registers its stop with the shutdown store whether or not this role starts it, so a role that
// never armed one still unwinds cleanly.
export const startBootSchedulers = ({ role, services, logger, shutdown }: BootPhase): void => {
    // Scheduled agent wake-ups: poll the automations manifest and fire whatever the owner configured there.
    const scheduler = createAutomationsScheduler(services, streamAgent);
    shutdown.push(() => scheduler.stop());
    if (role.container) {
        scheduler.start();
    }

    // Agent-armed condition checks, polled between turns. Wired here since a wake is itself a turn. Stop clears the
    // timers only; the watch journal survives for the next boot to restore.
    shutdown.push(startWatchers(services, streamAgent));

    // Follow-up for runtimes with no SDK Stop hook: a turn that edited code and never checked it gets one bounded
    // follow-up turn. Wired here since the turn generator can't be imported from under the caller.
    shutdown.push(startVerifyNudges(services, streamAgent));

    // Armed, not polled: reads the queue and sleeps until the soonest approved item is due. Arming here is what
    // survives a restart, since the deadline is the item's own scheduledAt on disk, not this timer. Dropping the timer
    // loses nothing: the next boot re-arms from that same scheduledAt.
    const approvalsExecutor = approvalsExecutorFor(services);
    shutdown.push(() => approvalsExecutor.stop());
    // A pre-push check runs a suite on the main tree; left alone at exit it burns CPU with nothing to report to.
    shutdown.push(() => prepushCheck(services).cancel());
    if (role.container) {
        void approvalsExecutor.arm().catch((error: unknown) => logger.warn({ err: error }, "approvals executor not armed"));
    }

    // Keeps every mapped repo's CI webhook pointed at this sandbox (boot + interval), so pipelines wake `ci`
    // automations.
    if (role.container) {
        services.ciHooks.start();
    }

    // Polls repos whose CI hook could not be registered (no public URL, a scopeless token) so their `ci` automations
    // still fire. Its first pass is a silent seed, so starting it early costs nothing (ci/poller.ts).
    const ciPoller = createCiPoller(services, streamAgent);
    shutdown.push(() => ciPoller.stop());
    if (role.container) {
        ciPoller.start();
    }

    if (role.container) {
        // Refreshes expired maintenance measurements (pnpm outdated/audit, knip, jscpd) for the rail. Serialized,
        // skipped while any turn is live, and held behind a warm-up so it never races the boot's own pnpm install.
        services.probeRunner.start();
        // Detects what the live container has that the image didn't, drafting overlay steps to capture it. Same
        // manners as the probe runner: idle-only, allowed to fail, unref'd. There is no image to drift from otherwise.
        services.driftSweep.start();
    }

    // Probes whether each runtime can serve a turn off the turn path, so a missing subscription surfaces before a
    // prompt is written.
    startRuntimeHealth(services);
    // Idle backstop for plan-limit headroom, re-read on every turn, refusal, or screen; this covers a sandbox where
    // nothing happens.
    services.headroom.start();
    // Workspace history: an immediate snapshot plus the interval sweep (turn snapshots ride on streamAgent).
    services.history.start();
};
