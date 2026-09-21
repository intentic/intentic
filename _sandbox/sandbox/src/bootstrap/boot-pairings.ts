import { seedSetupHost } from "../hosts/host-seed.js";
import type { BootPhase } from "./boot-phase.js";

// The enrollment tokens this sandbox was started with, armed once per boot so a desktop or a machine agent arriving
// later can still pair. Both are detached: whoever is enrolling retries on its own, and a token that never gets
// redeemed costs nothing.
export const armSetupPairings = ({ config, logger, services }: BootPhase): void => {
    // Arms the setup pairing token so the connect script's agent can enroll; no-op once redeemed (the burn is recorded
    // so a restart can't replay it).
    if (config.syncPairToken !== "") {
        void services.syncPairings
            .arm(config.syncPairToken, "sync")
            .catch((error: unknown) => logger.warn({ err: error }, "setup pairing not armed, enable desktop sync from the browser instead"));
    }

    // Creates the connected-device card once (its id is remembered so a deleted device isn't re-offered) and re-arms
    // its pairing every boot, since a late machine agent still needs a live token.
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
