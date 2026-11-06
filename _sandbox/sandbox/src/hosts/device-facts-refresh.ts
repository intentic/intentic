import { sleep } from "@intentic/base/async";
import type { Services } from "../composition.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";

// The hub's facts are the machine's answer to `describe` at hello, and a hello comes only with a new socket. What a row
// shows from them that can change under a live connection (the link count behind "Forget them") would otherwise hold
// until the next reconnect, so a device reading (device-reports.ts) asks again beside itself, at most every
// FACTS_EVERY_MS. A change is announced on its own: the reading's announcement only fires on news about the reading.

// The same deadline a reading has.
const DESCRIBE_TIMEOUT_MS = 8_000;

// How often a reading re-asks a machine to describe itself, beside the reading rather than inside it: the reading does
// not read the facts, and waiting on a third call to a loaded machine only delayed it (2026-11-06; every pull asked).
const FACTS_EVERY_MS = 2 * 60_000;

// How long after a drop of dead links the machine's own stamp has caught up: it rewrites it every 5s
// (LINK_STAMP_MS in the machine's device/config.ts), and the agent closes the dropped links on its next pass first.
const LINKS_SETTLE_MS = 12_000;

// When each machine was last asked to describe itself beside a reading.
const askedAt = new Map<string, number>();

const refreshFacts = async (services: Services, id: string): Promise<void> => {
    const before = JSON.stringify(services.hostHub.state(id).facts?.links);
    // Never costs the reading it rides beside: the last answer stands, as at hello.
    try {
        await services.hostHub.refresh(id, DESCRIBE_TIMEOUT_MS);
    } catch {
        // allow(silent-catch): a machine that did not re-describe itself keeps its facts from hello, which the row shows
        return;
    }
    if (JSON.stringify(services.hostHub.state(id).facts?.links) !== before) {
        publishRuntimeChange("hosts");
    }
};

/** Asks the machine to describe itself again unless a reading asked within FACTS_EVERY_MS; never waited on. */
export const refreshFactsBeside = (services: Services, id: string): void => {
    const asked = askedAt.get(id);
    if (asked !== undefined && Date.now() - asked < FACTS_EVERY_MS) {
        return;
    }
    askedAt.set(id, Date.now());
    void refreshFacts(services, id).catch((error: Error) =>
        services.logger.warn({ err: error, device: id }, "device reads: could not take what the machine said of itself"),
    );
};

/** The next reading of a machine that just changed asks for its facts too, however recently one did. */
export const factsDue = (id: string): void => void askedAt.delete(id);

// A drop leaves the agent running on the same socket, so no hello re-describes it. The read the view makes right after
// the drop lands before the machine's stamp catches up; this one lands after it.
export const refreshFactsOnceSettled = (services: Services, id: string): void =>
    void sleep(LINKS_SETTLE_MS, { unref: true })
        .then(async () => await refreshFacts(services, id))
        // allow(silent-catch): detached once the flow has ended; refreshFacts already keeps the last facts on a failed ask
        .catch(() => undefined);
