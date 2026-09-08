import { channelId, PushChannelSchema, type PushChannel } from "@intentic/sandbox-contract";
import webpush from "web-push";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

// This sandbox's VAPID keypair plus one entry per registered device (a browser's web-push subscription or a native
// relay channel, see PushChannelSchema).
// Lives on the HISTORY volume, not under /work/.intentic: these keys are signing/send credentials and must stay out of
// an agent's reach.
// The keypair is generated once, lazily, and never rotated; every live web-push channel is bound to the public key it
// was created with.

export interface PushState {
    readonly publicKey: string;
    readonly privateKey: string;
    readonly channels: readonly PushChannel[];
}

export interface PushStore {
    // Generates and persists the VAPID keypair on first call; only the public half reaches the browser.
    readonly keys: () => Promise<{ publicKey: string; privateKey: string }>;
    readonly list: () => Promise<readonly PushChannel[]>;
    // Upserts by channelId: a re-registering device replaces its row instead of duplicating it.
    readonly add: (channel: PushChannel) => Promise<void>;
    readonly remove: (id: string) => Promise<void>;
}

const StoredStateSchema = z.object({
    publicKey: z.string().min(1),
    privateKey: z.string().min(1),
    channels: z.array(PushChannelSchema).default([]),
});

// Must run only inside `update`: concurrent callers both seeing an empty publicKey would each mint and persist their
// own pair.
// Never rotated once written; every live web-push channel is bound to the public key it was created with.
const keyed = (state: PushState): PushState => (state.publicKey === "" ? { ...state, ...webpush.generateVAPIDKeys() } : state);

export const filePushStore = (path: string): PushStore => {
    const file = jsonFile<PushState>(path, {
        // Absent or corrupt state parses as unkeyed; `keyed` mints a fresh pair, and losing channels is recoverable.
        parse: (raw) => StoredStateSchema.safeParse(raw).data,
        // Empty keys are the in-memory unkeyed marker; the schema requires non-empty keys, so this never reaches disk.
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
                // Returns the same reference when the id wasn't registered, so a stale unsubscribe writes nothing.
                return channels.length === state.channels.length ? state : { ...state, channels };
            });
        },
    };
};
