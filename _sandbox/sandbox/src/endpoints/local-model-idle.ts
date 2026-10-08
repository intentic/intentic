// CPU ticks are the only idleness signal: requests reach llama-server through the translator, never the daemon.

// Long enough that a model in regular use never unloads between turns.
export const LOCAL_MODEL_IDLE_MS = 30 * 60_000;
export const LOCAL_MODEL_IDLE_SWEEP_MS = 60_000;
// How long a turn waits for an unloaded model to serve again before it is told the model is not serving.
export const LOCAL_MODEL_WAKE_MS = 45_000;

// A served model with nobody asking still spends CPU: llama-server's HTTP and slot threads wake on their own, measured
// at 2-4 ticks a minute on an idle Qwen3.5-2B (2026-10-08). Counting any movement as work meant that model never
// unloaded and sat on a gigabyte of swap for hours. One request costs far more than this floor, even with the weights
// on a GPU (tokenizing, sampling and the HTTP exchange alone), so a rate under it is housekeeping, not use.
export const LOCAL_MODEL_BUSY_TICKS_PER_MINUTE = 30;

export interface IdleSample {
    readonly cpuTicks: number;
    // When cpuTicks last moved faster than the busy floor, not when it was sampled.
    readonly busyAt: number;
    // When this sample was taken: the busy rate is measured against the previous sample, not against busyAt, so a
    // housekeeping trickle never adds up to a request.
    readonly sampledAt: number;
}

export interface IdleDecision {
    readonly next: Map<string, IdleSample>;
    readonly idle: readonly string[];
}

const busySince = (before: IdleSample, cpuTicks: number, now: number): boolean => {
    // At least a minute, so a sweep that runs early never inflates a couple of ticks into a rate.
    const minutes = Math.max((now - before.sampledAt) / 60_000, 1);
    // A total that went backwards is a different process on the same id (a restart the sweep missed): fresh work.
    return cpuTicks < before.cpuTicks || (cpuTicks - before.cpuTicks) / minutes >= LOCAL_MODEL_BUSY_TICKS_PER_MINUTE;
};

// `observed` is id → total CPU ticks of running servers; one no longer observed loses its sample and restarts its clock.
export const advanceIdle = (
    previous: ReadonlyMap<string, IdleSample>,
    observed: ReadonlyMap<string, number>,
    now: number,
    idleMs: number,
): IdleDecision => {
    const next = new Map<string, IdleSample>();
    const idle: string[] = [];
    for (const [id, cpuTicks] of observed) {
        const before = previous.get(id);
        // A server first seen now starts its clock now: a restarted daemon has no history to unload on.
        const busyAt = before === undefined || busySince(before, cpuTicks, now) ? now : before.busyAt;
        next.set(id, { cpuTicks, busyAt, sampledAt: now });
        if (idleMs > 0 && now - busyAt >= idleMs) {
            idle.push(id);
        }
    }
    return { next, idle };
};
