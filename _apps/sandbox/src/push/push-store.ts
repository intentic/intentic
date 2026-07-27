import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PushSubscription } from "@intentic/sandbox-contract";
import webpush from "web-push";

/* Persisted push state: this sandbox's VAPID keypair plus one entry per subscribed browser.
 *
 * It lives on the HISTORY volume, not under /work/.intentic like the other manifests, for one reason: the
 * VAPID private key is a signing credential, and everything under /work is inside the agent's reach. A key an
 * agent could read is a key that can forge notifications to the owner's devices, so it sits where `rm -rf`
 * and a stray Read both fail to find it — the same argument that puts the snapshot history there.
 *
 * The keypair is generated ONCE, lazily, on first use and never rotated: every live subscription is bound to
 * the public key it was created with, so rotating would silently orphan every device until each re-subscribed. */

export interface PushState {
    readonly publicKey: string;
    readonly privateKey: string;
    readonly subscriptions: readonly PushSubscription[];
}

export interface PushStore {
    // The VAPID keypair, generating and persisting it on first call. The public half is what a browser needs
    // to subscribe; the private half never leaves the daemon.
    readonly keys: () => Promise<{ publicKey: string; privateKey: string }>;
    readonly list: () => Promise<readonly PushSubscription[]>;
    // Upsert by endpoint — a browser re-subscribing (a new permission grant, a rotated endpoint) replaces its
    // row rather than accumulating duplicates that would each fire a notification.
    readonly add: (subscription: PushSubscription) => Promise<void>;
    readonly remove: (endpoint: string) => Promise<void>;
}

const read = async (path: string): Promise<PushState | undefined> => {
    try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        if (typeof parsed !== "object" || parsed === null) {
            return undefined;
        }
        const state = parsed as Partial<PushState>;
        if (typeof state.publicKey !== "string" || typeof state.privateKey !== "string") {
            return undefined;
        }
        return { publicKey: state.publicKey, privateKey: state.privateKey, subscriptions: state.subscriptions ?? [] };
    } catch {
        // Absent or corrupt — a fresh keypair is minted below. Losing subscriptions is recoverable (each
        // browser re-subscribes on next load); refusing to boot over it would not be.
        return undefined;
    }
};

export const filePushStore = (path: string): PushStore => {
    // Serializes read-modify-write so two concurrent subscribes can't lose one another's row. The whole file
    // is small and writes are rare, so one chained promise is the entire concurrency story.
    let queue: Promise<PushState> = Promise.resolve(undefined as unknown as PushState);
    let loaded: Promise<PushState> | undefined;

    const write = async (state: PushState): Promise<void> => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(state, undefined, 2)}\n`, { mode: 0o600 });
        loaded = Promise.resolve(state);
    };

    // The PROMISE is cached, not the state it resolves to — the difference is the whole correctness of first
    // use. `/push/config` reads keys() and list() with Promise.all, so on a fresh sandbox two loads run
    // concurrently; caching only the settled value leaves BOTH seeing "nothing loaded yet", and each mints its
    // own VAPID keypair. The browser then subscribes with the pair keys() happened to return while the daemon
    // keeps whichever write landed last — so every send to that browser is refused 403, the row is pruned as
    // dead, and notifications silently never arrive on a toggle that enabled cleanly.
    const load = (): Promise<PushState> => {
        if (loaded !== undefined) {
            return loaded;
        }
        const pending = (async (): Promise<PushState> => {
            const existing = await read(path);
            if (existing !== undefined) {
                return existing;
            }
            const generated = webpush.generateVAPIDKeys();
            const fresh: PushState = { publicKey: generated.publicKey, privateKey: generated.privateKey, subscriptions: [] };
            await write(fresh);
            return fresh;
        })();
        // An unwritable history volume must not poison the cache: a rejected promise left in place would keep
        // answering with the same stale failure long after the disk came back.
        loaded = pending.catch((error: unknown) => {
            loaded = undefined;
            throw error;
        });
        return loaded;
    };

    const mutate = (change: (state: PushState) => PushState): Promise<PushState> => {
        queue = queue.then(async () => {
            const next = change(await load());
            await write(next);
            return next;
        });
        return queue;
    };

    return {
        keys: async () => {
            const state = await load();
            return { publicKey: state.publicKey, privateKey: state.privateKey };
        },
        list: async () => (await load()).subscriptions,
        add: async (subscription) => {
            await mutate((state) => ({
                ...state,
                subscriptions: [...state.subscriptions.filter((entry) => entry.endpoint !== subscription.endpoint), subscription],
            }));
        },
        remove: async (endpoint) => {
            await mutate((state) => ({ ...state, subscriptions: state.subscriptions.filter((entry) => entry.endpoint !== endpoint) }));
        },
    };
};
