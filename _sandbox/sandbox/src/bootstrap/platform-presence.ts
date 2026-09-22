import { nextOneTimeWakeAt } from "../automations/scheduler.js";
import type { ReachPosture } from "../platform/listeners/ingress-tunnel.js";
import { DEFAULT_PROBES, startIdleStop } from "../system/idle-stop.js";
import type { BootPhase } from "./boot-phase.js";

// Container role only: a guest daemon or a local folder speaks for nobody.
export const startPlatformPresence = ({ config, logger, role, services, shutdown }: BootPhase, reach: ReachPosture): void => {
    // Started with the listeners so it can't queue behind the sweeps it reports through.
    if (config.platform.url !== "" && config.sandbox.publicUrl !== "" && config.connectToken !== "" && role.container) {
        services.announcer.start();
        services.reach.start(reach);
    }

    // 0 means always-on. A wake due before a stopped machine could be back keeps it up, since only a visit would restart it.
    if (config.idleStopMinutes > 0 && role.container) {
        shutdown.push(
            startIdleStop({ minutes: config.idleStopMinutes, logger }, { ...DEFAULT_PROBES, nextOneTimeWakeAt: () => nextOneTimeWakeAt(services) }),
        );
    }

    // Unawaited and self-swallowing: a platform that never answers means no trial offered.
    if (role.container) {
        void services.trial.refresh();
    }
};
