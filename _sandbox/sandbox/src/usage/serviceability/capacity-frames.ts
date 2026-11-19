import type { SystemEvent } from "@intentic/sandbox-contract/events/system-events";
import type { Services } from "../../composition.js";
import { capacitySnapshot, onCapacity } from "./capacity-feed.js";
import { nudgeCapacity } from "./capacity-watch.js";
import type { ServiceabilityDeps } from "./serviceability.js";

// Each provider's capacity as the daemon judges it again (capacity-watch.ts), for one /events connection that asked for
// it: every provider's as it stands when the connection opens, then each again as it moves. Nudging each provider arms
// its timer at the instant the clock alone changes it. Apart from system.routes.ts, which frames it per reader like the
// rest; returns the release.
export const subscribeCapacityFrames = (
    deps: ServiceabilityDeps & Pick<Services, "logger">,
    send: (event: SystemEvent) => void,
    open: () => boolean,
): (() => void) => {
    const release = onCapacity((capacity) => send({ kind: "capacity", capacity }));
    capacitySnapshot(deps)
        .then((snapshot) => {
            if (!open()) {
                return;
            }
            for (const capacity of snapshot.providers) {
                send({ kind: "capacity", capacity });
                nudgeCapacity(capacity.provider);
            }
        })
        .catch((error: unknown) => deps.logger.warn({ err: error }, "events: the capacity could not be judged for a new connection; its next change sends it"));
    return release;
};
