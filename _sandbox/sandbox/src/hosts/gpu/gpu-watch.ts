import type { Logger } from "pino";
import type { Services } from "../../composition.js";
import { logsRoot } from "../../seams/logs-root.js";
import { devices } from "../device-reports.js";
import { hostRunningSelf } from "../self-host.js";
import { keepGpuState } from "./gpu-state.js";
import { createCrashWatch } from "./host-crashes.js";

// How often the heartbeats' crash reports are read: a heartbeat is every 30 s, and a pause a minute after the computer
// is back is in time for the next GPU job, which a restarted sandbox's agents are only now starting.
const CRASH_PASS_MS = 60_000;

/**
 * The host GPU's part of boot (2026-11-03): gpu-run's state file kept in step with the settings, and the host's crash
 * reports kept and acted on (host-crashes.ts). Answers the stop. A daemon with no history volume (dev, tests) keeps
 * the state file only.
 */
export const startGpuWatch = (services: Services, logger: Pick<Logger, "warn">): (() => void) => {
    const stopState = keepGpuState(services.sandboxSettings, (message) => logger.warn(message));
    if (services.config.historyRoot === "") {
        return stopState;
    }
    const pass = createCrashWatch({
        logsDir: logsRoot(services.config.historyRoot),
        self: async () => hostRunningSelf(services),
        // allow(silent-catch): a listing that failed leaves the machine unknown, and the next pass asks again
        findSelf: () => void devices(services).catch(() => undefined),
        pinged: (door) => services.hostHub.state(door).pinged,
        connected: () => services.hostHub.connected(),
        settings: services.sandboxSettings,
        log: logger,
    });
    const timer = setInterval(() => {
        void pass().catch((error: Error) => logger.warn({ err: error }, "host: the host's crash reports could not be kept; the next pass tries again"));
    }, CRASH_PASS_MS);
    timer.unref();
    return () => {
        clearInterval(timer);
        stopState();
    };
};
