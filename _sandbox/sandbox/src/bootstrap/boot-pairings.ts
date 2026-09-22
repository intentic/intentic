import { seedSetupHost } from "../hosts/host-seed.js";
import type { BootPhase } from "./boot-phase.js";

// Both detached: whoever is enrolling retries on its own, and a token never redeemed costs nothing.
export const armSetupPairings = ({ config, logger, services }: BootPhase): void => {
    // No-op once redeemed: the burn is recorded so a restart can't replay it.
    if (config.syncPairToken !== "") {
        void services.syncPairings
            .arm(config.syncPairToken, "sync")
            .catch((error: unknown) => logger.warn({ err: error }, "setup pairing not armed, enable desktop sync from the browser instead"));
    }

    // The device is created once (a deleted device isn't re-offered); its pairing re-arms every boot.
    if (config.hostPairToken !== "") {
        void seedSetupHost(services, { token: config.hostPairToken, platform: config.hostPlatform, label: config.hostLabel })
            .then(({ offered, id }) => {
                if (offered) {
                    logger.info(
                        { host: id },
                        "setup device connected: it may manage this machine's sandboxes; widen or revoke on its capability card",
                    );
                }
            })
            .catch((error: unknown) =>
                logger.warn({ err: error }, "setup device not connected, add it from Capabilities to manage this machine's sandboxes"),
            );
    }
};
