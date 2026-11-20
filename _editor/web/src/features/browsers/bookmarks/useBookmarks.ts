import type { BookmarkAdd, BookmarkChanged, BookmarkNode, Bookmarks } from "@intentic/sandbox-contract/schemas/bookmarks";
import { OWN_BROWSING_PROFILE } from "@intentic/sandbox-contract/schemas/browsing";
import { computed, type ComputedRef, type MaybeRefOrGetter, toValue } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { optimisticUpdate } from "../../../lib/optimistic";
import { rpcKey } from "../../../lib/queryKeys";
import { isWithin, withMove } from "./bookmarkTree";

// A browser profile's bookmarks, read whole and kept current by the daemon's `bookmarks` push, so a star pressed in one
// window fills in every other. A removal, an edit or a move shows at once and is taken back if the sandbox refuses it;
// an addition waits for the sandbox, which mints its id.

// A bookmark or folder to make, in the profile the handle is for.
export type NewBookmark = Omit<BookmarkAdd, `profile`>;

// What an edit changes; each absent field is kept.
export interface BookmarkChange {
    title?: string;
    url?: string;
    parent?: string;
}

export interface BookmarksHandle {
    readonly nodes: ComputedRef<readonly BookmarkNode[]>;
    // Whether the sandbox has answered at all: before that, a page is not known to be unbookmarked.
    readonly loaded: ComputedRef<boolean>;
    readonly add: (input: NewBookmark) => Promise<BookmarkNode | undefined>;
    readonly edit: (id: string, change: BookmarkChange) => Promise<void>;
    readonly move: (id: string, parent: string, index: number) => Promise<void>;
    readonly remove: (id: string) => Promise<void>;
}

export const useBookmarks = (profile: MaybeRefOrGetter<string> = OWN_BROWSING_PROFILE): BookmarksHandle => {
    const input = computed(() => ({ profile: toValue(profile) }));
    const { query } = useSandboxQuery(rpcQuery(`bookmarks.list`, input));
    const nodes = computed<readonly BookmarkNode[]>(() => query.data.value?.nodes ?? []);
    const key = (): unknown[] => rpcKey(`bookmarks.list`, input.value);

    // A change shown at once and written, the list read again after either way.
    const changed = async (change: (held: readonly BookmarkNode[]) => BookmarkNode[], write: () => Promise<BookmarkChanged>, what: string): Promise<void> => {
        try {
            await optimisticUpdate<Bookmarks, BookmarkChanged>(key(), (held) => ({ ...held, nodes: change(held.nodes) }), write, { settle: true });
        } catch (error) {
            console.warn(`bookmarks: ${what} failed`, error);
        }
    };

    return {
        nodes,
        loaded: computed(() => query.data.value !== undefined),
        add: async (bookmark) => {
            try {
                const { node } = await sandboxRpc.bookmarks.add({ ...bookmark, profile: input.value.profile });
                await query.refetch();
                return node;
            } catch (error) {
                console.warn(`bookmarks: adding failed`, error);
                return undefined;
            }
        },
        edit: (id, change) =>
            changed(
                (held) => held.map((node) => (node.id === id ? { ...node, ...change, parent: change.parent ?? node.parent } : node)),
                () => sandboxRpc.bookmarks.edit({ profile: input.value.profile, id, ...change }),
                `editing`,
            ),
        move: (id, parent, index) =>
            changed(
                (held) => withMove(held, id, parent, index),
                () => sandboxRpc.bookmarks.move({ profile: input.value.profile, id, parent, index }),
                `moving`,
            ),
        remove: (id) =>
            changed(
                (held) => held.filter((node) => !isWithin(held, node.id, id)),
                () => sandboxRpc.bookmarks.remove({ profile: input.value.profile, id }),
                `removing`,
            ),
    };
};
