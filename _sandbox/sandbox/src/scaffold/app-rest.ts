import type { Logger } from "pino";

// Rests the workspace's autostarted apps (autostart.ts) while nobody is around, and starts them again the moment
// somebody is: a connected editor, or a visit to one of their previews. An app nobody looks at is still a dev server,
// its package manager, its bundler service and its log cleaner, ~500 MB measured idle on 2026-10-10, and a PC holding a
// dozen sandboxes holds a dozen of them. Only the apps the list names are rested, since the list is also what brings
// them back exactly as boot would; a server somebody started by hand is theirs.
// - quiet is a streak: any connected editor resets it, and a visit to one app's preview resets it for that app
// - resting stops the app's session; waking runs the same start the list's boot does

export interface AppRestDeps {
    readonly connected: () => number;
    // Called on every change of who is connected.
    readonly subscribeConnected: (listener: () => void) => () => void;
    // The keys the autostart list names, as boot reads it.
    readonly listed: () => Promise<readonly string[]>;
    readonly running: (key: string) => boolean;
    // Whether somebody is connected to the app right now (a browser tab holding its page or hot-reload socket, however
    // it reached it: the preview proxy, a port forwarded to the owner's own localhost). Counts as a visit.
    readonly inUse?: (key: string) => Promise<boolean>;
    readonly stop: (key: string) => void | Promise<void>;
    // Starts these listed apps, as boot does.
    readonly start: (keys: ReadonlySet<string>) => Promise<void>;
    readonly logger: Pick<Logger, "info" | "warn">;
}

export interface AppRest {
    // A preview of `key` was asked for. True when that woke a rested app, so the visitor can be told it is starting.
    readonly visit: (key: string) => boolean;
    // One pass of the check, as the timer runs it; exposed for tests.
    readonly check: () => Promise<void>;
    readonly rested: () => ReadonlySet<string>;
    readonly dispose: () => void;
}

const CHECK_INTERVAL_MS = 60_000;

export const startAppRest = (deps: AppRestDeps, options: { readonly idleMs: number; readonly checkMs?: number }): AppRest => {
    let quietSince = Date.now();
    const visitedAt = new Map<string, number>();
    const rested = new Set<string>();

    const wake = (keys: ReadonlySet<string>, why: string): void => {
        if (keys.size === 0) {
            return;
        }
        const waking = new Set(keys);
        for (const key of waking) {
            rested.delete(key);
        }
        deps.logger.info({ apps: [...waking], why }, "app rest: starting rested workspace apps again");
        void deps.start(waking).catch((error: unknown) => deps.logger.warn({ err: error, apps: [...waking] }, "app rest: rested apps could not be started"));
    };

    const check = async (): Promise<void> => {
        if (deps.connected() > 0) {
            quietSince = Date.now();
            return;
        }
        const listed = await deps.listed();
        // Read again after the await: somebody may have connected while the list was read.
        if (deps.connected() > 0) {
            quietSince = Date.now();
            return;
        }
        for (const key of listed) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of apps, each a read of the socket tables
            if (deps.running(key) && (await deps.inUse?.(key).catch(() => false)) === true) {
                visitedAt.set(key, Date.now());
            }
        }
        const now = Date.now();
        for (const key of listed) {
            const lastSeen = Math.max(quietSince, visitedAt.get(key) ?? 0);
            if (rested.has(key) || !deps.running(key) || now - lastSeen < options.idleMs) {
                continue;
            }
            rested.add(key);
            deps.logger.info({ app: key, quietMs: now - lastSeen }, "app rest: nobody around, resting a workspace app until somebody is");
            // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of apps, stopped one after another
            await Promise.resolve(deps.stop(key)).catch((error: unknown) => deps.logger.warn({ err: error, app: key }, "app rest: could not stop a workspace app"));
        }
    };

    const timer = setInterval(
        () => void check().catch((error: unknown) => deps.logger.warn({ err: error }, "app rest: check failed")),
        options.checkMs ?? CHECK_INTERVAL_MS,
    );
    // A watchdog must never hold the event loop open on its own.
    timer.unref();

    const unsubscribe = deps.subscribeConnected(() => {
        if (deps.connected() > 0) {
            quietSince = Date.now();
            wake(rested, "somebody connected");
        }
    });

    return {
        visit: (key) => {
            visitedAt.set(key, Date.now());
            if (!rested.has(key)) {
                return false;
            }
            wake(new Set([key]), "its preview was visited");
            return true;
        },
        check,
        rested: () => new Set(rested),
        dispose: () => {
            clearInterval(timer);
            unsubscribe();
        },
    };
};

// The one running in this daemon, for the preview door that is opened before the apps are: a visit before it exists
// (or in a daemon that rests nothing) wakes nothing.
let current: AppRest | undefined;

export const installAppRest = (rest: AppRest): (() => void) => {
    current = rest;
    return () => {
        if (current === rest) {
            current = undefined;
        }
        rest.dispose();
    };
};

export const visitWorkspaceApp = (key: string): boolean => current?.visit(key) ?? false;
