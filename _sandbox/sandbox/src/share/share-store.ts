import { SharedConversationSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

/* WHAT HAS BEEN SHARED — the daemon's own list, on the history volume beside the transcripts.
 *
 * The outbox itself cannot answer this. It holds files: walking it would find a directory of assets and a page
 * per share, with no way to say which conversation a page came from, what detail level it was taken at, or
 * when. Update needs the first, the Public view's row needs all three, and none of them survive a round trip
 * through a rendered page.
 *
 * On /history rather than in the workspace for the reason every other ledger is: it is daemon state, the agent
 * has no business editing it, and it must survive the container rebuilds that recreate everything under ~/.
 *
 * The list is the INDEX, not the truth — the pages in the outbox are. A row whose page has been deleted by
 * hand is a row the next `list` still shows and the next Update rewrites, which is the harmless direction to
 * be wrong in: the alternative (a page nobody can see in the app, still answering on the internet) is not. */

// `url` is minted per read from the sandbox's current tunnel, never stored: a sandbox that changes zone would
// otherwise hand out addresses that stopped resolving, and the row would look fine while the link was dead.
const StoredShareSchema = SharedConversationSchema.omit({ url: true });
export type StoredShare = z.infer<typeof StoredShareSchema>;

const FileSchema = z.object({ shares: z.array(StoredShareSchema) });

export interface ShareStore {
    readonly all: () => Promise<StoredShare[]>;
    readonly get: (id: string) => Promise<StoredShare | undefined>;
    // Add or replace by id — the same call behind a first share and an Update, which differ only in whether
    // the id already exists.
    readonly put: (share: StoredShare) => Promise<void>;
    readonly remove: (id: string) => Promise<void>;
}

// Newest first: the row someone is looking for right after sharing is the one they just made.
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
