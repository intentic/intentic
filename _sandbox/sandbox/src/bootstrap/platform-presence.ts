import type { ReachPosture } from "../system/listeners/reach-posture.js";
import { DEFAULT_PROBES, startIdleStop } from "../system/idle-stop.js";
import { fileRestartResume } from "../system/restart-resume.js";
import type { BootPhase } from "./boot-phase.js";
import { nextPromisedWake } from "./promised-wakes.js";
import { workingNow } from "./working-now.js";

// The soonest moment this sandbox promised somebody that a stop for idleness must not sleep through, 0 for none: one list
// (promised-wakes.ts), shared with the automatic update's.
export const nextPromisedWakeAt = async (services: BootPhase["services"]): Promise<number> => (await nextPromisedWake(services, "idle-stop")) ?? 0;

// Container role only: a guest daemon or a local folder speaks for nobody.
export const startPlatformPresence = ({ config, logger, role, services, shutdown }: BootPhase, reach: ReachPosture): void => {
    // Started with the listeners so it can't queue behind the sweeps it reports through.
    if (config.platform.url !== "" && config.sandbox.publicUrl !== "" && config.connectToken !== "" && role.container) {
        services.announcer.start();
        services.reach.start(reach);
    }
    // The organisation policy, from the same platform over the same token; a personal sandbox is answered null each time.
    if (config.platform.url !== "" && config.connectToken !== "") {
        services.orgPolicy.start();
    }

    // 0 means always-on. A wake due before a stopped machine could be back keeps it up, since only a visit would restart it.
    if (config.idleStopMinutes > 0 && role.container) {
        shutdown.push(
            startIdleStop(
                { minutes: config.idleStopMinutes, logger },
                {
                    ...DEFAULT_PROBES,
                    working: () => workingNow(services, "idle-stop").length,
                    nextPromisedWakeAt: () => nextPromisedWakeAt(services),
                },
                // Named as the initiator before the SIGTERM main.ts answers, so the stop and the next boot say why.
                () => {
                    fileRestartResume(config.historyRoot).announce?.({
                        by: "daemon",
                        action: "stop",
                        reason: `idle-stop: nobody connected and nothing running for ${String(config.idleStopMinutes)} minutes`,
                    });
                    process.kill(process.pid, "SIGTERM");
                },
            ),
        );
    }

    // Unawaited and self-swallowing: a platform that never answers means no trial offered.
    if (role.container) {
        void services.trial.refresh();
    }
};
