import { SharedConversationSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

// Daemon's own list of what's shared, on the history volume; the outbox's files alone can't say which conversation,
// detail level, or when. An index, not the truth: a row surviving after its page was deleted by hand is harmless,
// unlike a live page the list has forgotten.

// `url` is minted per read from the current tunnel, never stored, so a zone change can't strand a dead link.
const StoredShareSchema = SharedConversationSchema.omit({ url: true });
export type StoredShare = z.infer<typeof StoredShareSchema>;

const FileSchema = z.object({ shares: z.array(StoredShareSchema) });

export interface ShareStore {
    readonly all: () => Promise<StoredShare[]>;
    readonly get: (id: string) => Promise<StoredShare | undefined>;
    // Add or replace by id; the same call backs both a first share and an update.
    readonly put: (share: StoredShare) => Promise<void>;
    readonly remove: (id: string) => Promise<void>;
}

// Newest first: the row just shared is the one someone's looking for right after.
const sorted = (shares: readonly StoredShare[]): StoredShare[] => shares.toSorted((left, right) => right.sharedAt - left.sharedAt);

export const fileShareStore = (path: string): ShareStore => {
    const file = jsonFile(path, {
        parse: (raw) => {
            const parsed = FileSchema.safeParse(raw);
            return parsed.success ? parsed.data : undefined;
        },
        fallback: () => ({ shares: [] }),
    });
    return {
        all: async () => sorted((await file.read()).shares),
        get: async (id) => (await file.read()).shares.find((share) => share.id === id),
        put: async (share) => {
            await file.update((current) => ({ shares: [...current.shares.filter((entry) => entry.id !== share.id), share] }));
        },
        remove: async (id) => {
            await file.update((current) => ({ shares: current.shares.filter((share) => share.id !== id) }));
        },
    };
};
