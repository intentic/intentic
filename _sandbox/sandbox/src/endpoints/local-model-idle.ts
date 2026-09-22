// CPU ticks are the only idleness signal: requests reach llama-server through the translator, never the daemon.

// Long enough that a model in regular use never unloads between turns.
export const LOCAL_MODEL_IDLE_MS = 30 * 60_000;
export const LOCAL_MODEL_IDLE_SWEEP_MS = 60_000;
// How long a turn waits for an unloaded model to serve again before it is told the model is not serving.
export const LOCAL_MODEL_WAKE_MS = 45_000;

export interface IdleSample {
    readonly cpuTicks: number;
    // When cpuTicks last changed, not when it was sampled.
    readonly busyAt: number;
}

export interface IdleDecision {
    readonly next: Map<string, IdleSample>;
    readonly idle: readonly string[];
}

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
        const busyAt = before === undefined || before.cpuTicks !== cpuTicks ? now : before.busyAt;
        next.set(id, { cpuTicks, busyAt });
        if (idleMs > 0 && now - busyAt >= idleMs) {
            idle.push(id);
        }
    }
    return { next, idle };
};
