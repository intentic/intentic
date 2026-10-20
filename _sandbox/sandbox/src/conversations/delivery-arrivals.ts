import type { ProjectDeliveryDeps } from "./land/project-delivery.js";

// When project delivery looks for a machine that can take the lands waiting for it: the moment the hub announces the
// connected machines changed (`hostsChanged`, the runtime feed's `hosts` domain), and on a slow timer only as the
// fallback for an announcement missed (2026-10-20; the timer alone looked every 15 s).
const ARRIVALS_EVERY_MS = 60_000;

/** Runs `check` on every announcement and on the fallback timer; answers the stop. */
export const watchArrivals = (deps: Pick<ProjectDeliveryDeps, "hostsChanged" | "logger">, check: () => Promise<void>): (() => void) => {
    const look = (): void => {
        void check().catch((cause: unknown) => deps.logger.warn({ err: cause }, "project delivery: waiting lands were not tried again"));
    };
    const unhosts = deps.hostsChanged?.(look) ?? (() => undefined);
    const timer = setInterval(look, ARRIVALS_EVERY_MS);
    timer.unref();
    return () => {
        unhosts();
        clearInterval(timer);
    };
};
