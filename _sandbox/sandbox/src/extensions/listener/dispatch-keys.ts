import type { Services } from "../../composition.js";

// A gateway retries a message until the daemon admits it (connector-runtime's dispatch spool), naming it by the same
// key every time (the contract's LISTENER_DISPATCH_KEY_HEADER). A retry whose first try was admitted but never answered
// (the answer lost on the wire, the gateway timed out) must not wake the automation a second time, so the keys admitted
// lately are kept here, and a request racing its own retry waits for the first rather than admitting beside it.
// Memory only: a daemon that restarts between admitting a message and answering it can admit its retry again. That
// window is the inbox write itself, milliseconds, where the gateway's spool keeps the message for minutes.

// How long and how many admitted keys are kept: far past any gateway's retry of one message, which gives up within a day
// only when the daemon stayed down, and then never admitted it.
const KEPT_MS = 60 * 60 * 1000;
const KEPT_MAX = 5_000;

interface Admissions {
    readonly done: Map<string, number>;
    readonly running: Map<string, Promise<readonly string[]>>;
}

// One per daemon, found by its automations store, as the automation dispatchers keep theirs: a restart test's second
// daemon on the same history starts with none of the first's.
const admissionsOfStore = new WeakMap<object, Admissions>();
const admissionsOf = {
    of: (services: Pick<Services, "automations">): Admissions => {
        const found = admissionsOfStore.get(services.automations);
        if (found !== undefined) {
            return found;
        }
        const made: Admissions = { done: new Map(), running: new Map() };
        admissionsOfStore.set(services.automations, made);
        return made;
    },
};

// Runs `admit` once per key, answering the automations it matched, or undefined for a key already admitted (or being
// admitted right now, once that settles). A failed admission keeps nothing, so its retry admits for real. No key, no
// memory: an older gateway's message admits every time, as it always did.
export const admitOnce = async (
    services: Pick<Services, "automations">,
    provider: string,
    key: string | undefined,
    admit: () => Promise<readonly string[]>,
    now: () => number = Date.now,
): Promise<readonly string[] | undefined> => {
    if (key === undefined || key === "") {
        return admit();
    }
    const { done, running } = admissionsOf.of(services);
    const id = `${provider}\u0000${key}`;
    const at = done.get(id);
    if (at !== undefined && now() - at <= KEPT_MS) {
        return undefined;
    }
    const inFlight = running.get(id);
    if (inFlight !== undefined) {
        await inFlight;
        return undefined;
    }
    const admission = admit();
    running.set(id, admission);
    try {
        const matched = await admission;
        done.delete(id);
        done.set(id, now());
        for (const [oldest, when] of done) {
            if (done.size <= KEPT_MAX && now() - when <= KEPT_MS) {
                break;
            }
            done.delete(oldest);
        }
        return matched;
    } finally {
        running.delete(id);
    }
};
