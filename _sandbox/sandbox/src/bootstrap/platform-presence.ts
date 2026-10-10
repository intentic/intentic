import { nextOneTimeWakeAt } from "../automations/scheduler.js";
import type { ReachPosture } from "../system/listeners/reach-posture.js";
import { DEFAULT_PROBES, startIdleStop } from "../system/idle-stop.js";
import type { BootPhase } from "./boot-phase.js";
import { workingNow } from "./working-now.js";
import { nextBookedSendAt } from "../agent/run/turn/turn-resume.js";

// The sooner of two wakes, either 0 for none.
const sooner = (a: number, b: number): number => (a === 0 ? b : b === 0 ? a : Math.min(a, b));

// The soonest moment this sandbox promised somebody, 0 for none: a one-time automation, a person's scheduled send, and a
// held turn booked to go again when its allowance reopens, since the sandbox's own clock is all that lets any of them go.
// What a stop for idleness must not sleep through.
export const nextPromisedWakeAt = async (services: BootPhase["services"]): Promise<number> =>
    sooner(await nextOneTimeWakeAt(services), await nextBookedSendAt(services));

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
            startIdleStop(
                { minutes: config.idleStopMinutes, logger },
                {
                    ...DEFAULT_PROBES,
                    working: () => workingNow(services, "idle-stop").length,
                    nextOneTimeWakeAt: () => nextPromisedWakeAt(services),
                },
            ),
        );
    }

    // Unawaited and self-swallowing: a platform that never answers means no trial offered.
    if (role.container) {
        void services.trial.refresh();
    }
};
