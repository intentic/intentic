import { nextOneTimeWakeAt } from "../automations/scheduler.js";
import type { ReachPosture } from "../platform/listeners/ingress-tunnel.js";
import { DEFAULT_PROBES, startIdleStop } from "../system/idle-stop.js";
import type { BootPhase } from "./boot-phase.js";

// What this sandbox tells the platform at boot and what it asks back: that it is online at a URL, whether that URL
// actually answers, the trial allowance it may offer, and the quiet window after which it stops its own machine.
// Container role only: a guest daemon or a local folder speaks for nobody.
export const startPlatformPresence = ({ config, logger, role, services, shutdown }: BootPhase, reach: ReachPosture): void => {
    // Announces this sandbox's URL to the platform registry once per boot, retried until acked, so the setup wizard
    // sees it online unprompted. Started with the listeners so it can't queue behind the sweeps it reports through.
    if (config.platform.url !== "" && config.sandbox.publicUrl !== "" && config.connectToken !== "" && role.container) {
        services.announcer.start();
        /* And immediately: does that public URL actually answer? Started here rather than after the boot. */
        services.reach.start(reach);
    }

    // Hosted idle-stop: after a quiet window (nobody connected, no turn, no terminal activity) the daemon exits
    // gracefully so its machine can stop; the platform restarts it on the next visit. 0 means always-on.
    // The automations manifest is read here rather than inside the watchdog, which knows nothing of the workspace: a
    // wake due before a stopped machine could be back keeps it up, since only a visit would restart it.
    if (config.idleStopMinutes > 0 && role.container) {
        shutdown.push(
            startIdleStop({ minutes: config.idleStopMinutes, logger }, { ...DEFAULT_PROBES, nextOneTimeWakeAt: () => nextOneTimeWakeAt(services) }),
        );
    }

    // Asks the platform for this sandbox's trial allowance so it's ready before the user's first chat, not a sweep
    // later. Unawaited and self-swallowing: a platform that never answers just means no trial offered.
    if (role.container) {
        void services.trial.refresh();
    }
};
