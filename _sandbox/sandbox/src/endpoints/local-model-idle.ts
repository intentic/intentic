// Which local model servers have gone long enough without work to be worth unloading, as a pure function of CPU
// samples.
//
// CPU TIME IS THE SIGNAL because nothing else can see the traffic. A turn reaches llama-server through the translator
// (cli-proxy-api), a process of its own, so the daemon never observes a request and cannot timestamp one. What it can
// observe is that a server which is generating burns CPU and a server which is merely loaded does not — and "merely
// loaded" is the expensive state: measured at 1.45 GB resident plus 661 MB pushed to swap for a 2B model holding a
// 64k KV cache it was not using.

// Half an hour without generating a token. Long enough that a model in regular use never unloads between turns, short
// enough that one left from an experiment stops holding gigabytes all day.
export const LOCAL_MODEL_IDLE_MS = 30 * 60_000;
export const LOCAL_MODEL_IDLE_SWEEP_MS = 60_000;
// What a turn waits for an unloaded model to come back before giving up. Loading weights the page cache still holds
// is seconds; past this the turn is better off being told the model is not serving than going on waiting.
export const LOCAL_MODEL_WAKE_MS = 45_000;

export interface IdleSample {
    readonly cpuTicks: number;
    // When cpuTicks last CHANGED. Not when the sample was taken: the gap between those two is the idleness.
    readonly busyAt: number;
}

export interface IdleDecision {
    readonly next: Map<string, IdleSample>;
    readonly idle: readonly string[];
}

// `observed` is id → total CPU ticks, for the servers that are running right now. One that has stopped simply stops
// being observed, which drops its sample: a server that comes back starts its clock again rather than inheriting the
// idleness of the one before it.
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
        // A server seen for the first time starts its clock now, so a daemon restart cannot unload one on its first
        // pass on the strength of a history it never had.
        const busyAt = before === undefined || before.cpuTicks !== cpuTicks ? now : before.busyAt;
        next.set(id, { cpuTicks, busyAt });
        if (idleMs > 0 && now - busyAt >= idleMs) {
            idle.push(id);
        }
    }
    return { next, idle };
};
