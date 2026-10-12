import type { RunnerHub } from "./runner-peer.js";

// A runner says how full it is when it connects, and the hub keeps that answer: hours later it still describes the
// moment of the hello. Anything that compares machines (the fleet advice, a fan-out's placement) asks for fresh facts
// here first. Only while someone is asking: a composer that is closed costs the runners nothing.

// Facts younger than this are fresh enough to compare by: load averages and memory move on a scale of seconds.
export const FACTS_FRESH_MS = 10_000;
// A runner that does not answer within this keeps its last facts; the comparison waits on it no longer than that.
export const DESCRIBE_TIMEOUT_MS = 2_500;

interface Measuring {
    // When each runner last answered, by id; a runner that never did is absent.
    readonly at: Map<string, number>;
    // One refresh per runner at a time, joined by every caller that asks meanwhile.
    readonly pending: Map<string, Promise<void>>;
}

// What a refresh needs of the hub: whether a runner is connected, and a way to ask it again.
export type FactsHub = Pick<RunnerHub, "client" | "refresh">;

// Kept beside the hub it measures, so a test's fresh hub starts from nothing.
const measuring = new WeakMap<FactsHub, Measuring>();
const measuringOf = (hub: FactsHub): Measuring => {
    let state = measuring.get(hub);
    if (state === undefined) {
        state = { at: new Map(), pending: new Map() };
        measuring.set(hub, state);
    }
    return state;
};

// Re-asks every named runner that is online and whose facts are older than FACTS_FRESH_MS. Never rejects: a runner that
// fails to answer keeps what it said last, which the hub already holds, and is not asked again until FACTS_FRESH_MS has
// passed, so a runner that hangs costs each caller its timeout once in that window rather than on every ask.
export const refreshRunnerFacts = async (
    hub: FactsHub,
    ids: readonly string[],
    now: () => number = Date.now,
): Promise<void> => {
    const state = measuringOf(hub);
    await Promise.all(
        ids
            .filter((id) => hub.client(id) !== undefined && now() - (state.at.get(id) ?? 0) >= FACTS_FRESH_MS)
            .map((id) => {
                const pending = state.pending.get(id);
                if (pending !== undefined) {
                    return pending;
                }
                const asked = hub
                    .refresh(id, DESCRIBE_TIMEOUT_MS)
                    .then(() => {
                        state.at.set(id, now());
                    })
                    // allow(silent-catch): `refresh` keeps the last answer on a failure; nothing more to recover here.
                    .catch(() => undefined)
                    .finally(() => {
                        state.pending.delete(id);
                    });
                state.pending.set(id, asked);
                return asked;
            }),
    );
};
