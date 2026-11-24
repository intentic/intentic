// The providers listing's way to hear the owner's other sandboxes' run-outs first (agent/providers/accounts/
// pool-signals.ts), as a port the daemon's boot fills: the listing sits under agent/subagents, which may not reach into
// agent/providers by value without closing a cycle through agent/run.

export interface PoolSignalHearing {
    // Hears now unless it heard within the last minute; never rejects, and waits at most a couple of seconds.
    readonly hearSoon: () => Promise<void>;
}

let hearing: PoolSignalHearing | undefined;

/** Set by the daemon's boot, cleared by its shutdown. */
export const providePoolSignalHearing = (port: PoolSignalHearing | undefined): void => {
    hearing = port;
};

/** Hears through the daemon's listener as the providers listing is built; nothing where none was started. */
export const hearPoolSignalsSoon = (): Promise<void> => hearing?.hearSoon() ?? Promise.resolve();
