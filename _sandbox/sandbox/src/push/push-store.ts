import { channelId, type PushChannel, RelayChannelSchema, WebPushChannelSchema } from "@intentic/sandbox-contract";
import webpush from "web-push";
import { z } from "zod";
import { opt } from "../opt.js";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

// This sandbox's VAPID keypair plus one entry per registered device (a browser's web-push subscription or a native
// relay channel, see PushChannelSchema), each with the member who registered it.
// Lives on the HISTORY volume, not under /work/.intentic: these keys are signing/send credentials and must stay out of
// an agent's reach.
// The keypair is generated once, lazily, and never rotated; every live web-push channel is bound to the public key it
// was created with.

// `member` is the verified email of whoever registered the device, which push.ts reads to skip only the devices of a
// member who is looking. Absent on a row stored before devices named their member and on one registered by a caller
// with no member identity (loopback); such a row stays quiet while anyone at all is looking.
const MEMBER = { member: z.string().min(1).optional() };
const StoredChannelSchema = z.discriminatedUnion("kind", [WebPushChannelSchema.extend(MEMBER), RelayChannelSchema.extend(MEMBER)]);
export type StoredChannel = z.infer<typeof StoredChannelSchema>;

export interface PushState {
    readonly publicKey: string;
    readonly privateKey: string;
    readonly channels: readonly StoredChannel[];
}

export interface PushStore {
    // Generates and persists the VAPID keypair on first call; only the public half reaches the browser.
    readonly keys: () => Promise<{ publicKey: string; privateKey: string }>;
    readonly list: () => Promise<readonly StoredChannel[]>;
    // Upserts by channelId: a re-registering device replaces its row instead of duplicating it, and belongs to whoever
    // registered it last (`member`, absent for a caller with no member identity).
    readonly add: (channel: PushChannel, member?: string) => Promise<void>;
    readonly remove: (id: string) => Promise<void>;
}

const StoredStateSchema = z.object({
    publicKey: z.string().min(1),
    privateKey: z.string().min(1),
    channels: z.array(StoredChannelSchema).default([]),
});

export const pushDocument = defineDocument({ root: "history", path: "push.json", schema: StoredStateSchema });

// Must run only inside `update`: concurrent callers both seeing an empty publicKey would each mint and persist their
// own pair.
// Never rotated once written; every live web-push channel is bound to the public key it was created with.
const keyed = (state: PushState): PushState => (state.publicKey === "" ? { ...state, ...webpush.generateVAPIDKeys() } : state);

export const filePushStore = (path: string): PushStore => {
    // Absent or corrupt state parses as unkeyed; `keyed` mints a fresh pair, and losing channels is recoverable.
    const file = openDocument<typeof pushDocument, PushState>(pushDocument, path, {
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
        add: async (channel, member) => {
            const row: StoredChannel = { ...channel, ...opt("member", member) };
            await file.update((state) => ({
                ...keyed(state),
                channels: [...state.channels.filter((entry) => channelId(entry) !== channelId(row)), row],
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
