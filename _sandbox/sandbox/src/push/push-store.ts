import { channelId, PushChannelSchema, type PushChannel } from "@intentic/sandbox-contract";
import webpush from "web-push";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

/* Persisted push state: this sandbox's VAPID keypair plus one entry per registered device — a browser's
 * web-push subscription or a native install's relay channel (see PushChannelSchema for the split).
 *
 * It lives on the HISTORY volume, not under /work/.intentic like the other manifests, for one reason: the
 * VAPID private key is a signing credential, and a relay channel's secret is a send capability — both are
 * inside the agent's reach anywhere under /work. A credential an agent could read is a credential that can
 * forge notifications to the owner's devices, so it sits where `rm -rf` and a stray Read both fail to find
 * it — the same argument that puts the snapshot history there.
 *
 * The keypair is generated ONCE, lazily, on first use and never rotated: every live web-push channel is bound
 * to the public key it was created with, so rotating would silently orphan every browser until each
 * re-subscribed. */

export interface PushState {
    readonly publicKey: string;
    readonly privateKey: string;
    readonly channels: readonly PushChannel[];
}

export interface PushStore {
    // The VAPID keypair, generating and persisting it on first call. The public half is what a browser needs
    // to subscribe; the private half never leaves the daemon. Native channels never touch it.
    readonly keys: () => Promise<{ publicKey: string; privateKey: string }>;
    readonly list: () => Promise<readonly PushChannel[]>;
    // Upsert by channelId — a device re-registering (a new permission grant, a rotated endpoint, a
    // reinstalled app) replaces its row rather than accumulating duplicates that would each fire.
    readonly add: (channel: PushChannel) => Promise<void>;
    readonly remove: (id: string) => Promise<void>;
}

const StoredStateSchema = z.object({
    publicKey: z.string().min(1),
    privateKey: z.string().min(1),
    channels: z.array(PushChannelSchema).default([]),
});

/* Generate the VAPID pair on first use, and only ever inside `update` — which is the whole correctness of first
 * use. `/push/config` reads keys() and list() with Promise.all, so on a fresh sandbox two callers arrive
 * together; unserialized, both see "nothing generated yet" and each mints its own pair. The browser then
 * subscribes with whichever keys() returned while the daemon keeps whichever write landed last — so every send
 * to that browser is refused 403, the row is pruned as dead, and notifications silently never arrive on a
 * toggle that enabled cleanly. Serializing is what makes the pair generate exactly once.
 *
 * Never rotated once written: every live web-push channel is bound to the public key it was created with, so
 * rotating would silently orphan every browser until each re-subscribed. */
const keyed = (state: PushState): PushState => (state.publicKey === "" ? { ...state, ...webpush.generateVAPIDKeys() } : state);

export const filePushStore = (path: string): PushStore => {
    const file = jsonFile<PushState>(path, {
        // Absent or corrupt reads as unkeyed, and `keyed` mints a fresh pair. Losing channels is recoverable
        // (each device re-registers on next load); refusing to boot over it would not be.
        parse: (raw) => StoredStateSchema.safeParse(raw).data,
        // Empty keys are the in-memory "not generated yet" marker — the schema requires non-empty ones, so
        // this shape never reaches disk.
        fallback: () => ({ publicKey: "", privateKey: "", channels: [] }),
        mode: 0o600,
    });

    return {
        keys: async () => {
            const { publicKey, privateKey } = await file.update(keyed);
            return { publicKey, privateKey };
        },
        list: async () => (await file.read()).channels,
        add: async (channel) => {
            await file.update((state) => ({
                ...keyed(state),
                channels: [...state.channels.filter((entry) => channelId(entry) !== channelId(channel)), channel],
            }));
        },
        remove: async (id) => {
            await file.update((state) => {
                const channels = state.channels.filter((entry) => channelId(entry) !== id);
                // Unchanged by reference when the id wasn't registered, so a stale unsubscribe writes
                // nothing — and, in particular, does not mint a keypair for a sandbox that has none.
                return channels.length === state.channels.length ? state : { ...state, channels };
            });
        },
    };
};
