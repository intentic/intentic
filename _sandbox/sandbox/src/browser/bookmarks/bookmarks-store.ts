import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import type { BookmarkAdd, BookmarkEdit, BookmarkMove, BookmarkNode, Bookmarks } from "@intentic/sandbox-contract/schemas/bookmarks";
import { z } from "zod";
import { stateRelPath } from "../../state-paths.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDirectory } from "../../store/open-document.js";
import { BookmarkTree, mintBookmarkId } from "./bookmark-tree.js";

// Each browser profile's bookmarks (bookmark-tree.ts), one file per profile beside the profiles themselves
// (`.intentic/local/browser/_bookmarks/`, an underscore no account's profile takes, as `_own` is). Loaded on first use,
// seeded once from Chromium's own Bookmarks where the profile has one, and saved whole after every change, before the
// change is answered: a tree is a few kilobytes, and a bookmark made is expected to be there. Every change is announced
// (`changed`), which the routes turn into the `bookmarks` runtime push.
//
// Under the profiles' directory, so like them it does not travel in a bundle: neither do Chromium's own bookmarks in
// the profile, which the first read here takes in.

const NodeSchema = z.object({
    id: z.string(),
    kind: z.enum(["url", "folder"]),
    title: z.string(),
    url: z.string().optional(),
    parent: z.string().optional(),
    added: z.number(),
    favicon: z.string().optional(),
});
const BookmarksFileSchema = z.object({
    // The profile's own key, which the file name only approximates.
    profile: z.string(),
    // Whether Chromium's own Bookmarks were taken in already, so they are read once, not on every start.
    seeded: z.boolean(),
    // Depth first, the roots first: the order within a folder is the order here.
    nodes: z.array(NodeSchema),
});
type BookmarksFile = z.infer<typeof BookmarksFileSchema>;

export const bookmarksDocument = defineDocument({
    path: stateRelPath(".intentic/local/browser/", "_bookmarks"),
    directory: true,
    schema: BookmarksFileSchema,
});

// A profile key as a file id: what jsonDir takes is narrower than an account id, so anything else is spelled out.
const fileIdOf = (profile: string): string => `p-${profile.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 60);

export interface BookmarksProblem {
    readonly profile: string;
    readonly err: string;
}

export interface BookmarksStoreDeps {
    readonly root: string;
    // Chromium's own bookmarks of a profile, as nodes inside the two roots; undefined where the profile keeps none.
    readonly chromiumBookmarks: (profile: string, mint: () => string) => Promise<BookmarkNode[] | undefined>;
    // Called after every change a profile's tree took.
    readonly changed: (profile: string) => void;
    readonly warn: (problem: BookmarksProblem, message: string) => void;
    readonly now?: () => number;
    readonly mint?: () => string;
}

export interface BookmarksStore {
    readonly list: (profile: string) => Promise<Bookmarks>;
    readonly add: (input: BookmarkAdd) => Promise<BookmarkNode>;
    readonly edit: (input: BookmarkEdit) => Promise<BookmarkNode>;
    readonly move: (input: BookmarkMove) => Promise<BookmarkNode>;
    // Whether anything was there to remove.
    readonly remove: (profile: string, id: string) => Promise<boolean>;
}

export const bookmarksStore = (deps: BookmarksStoreDeps): BookmarksStore => {
    const now = deps.now ?? Date.now;
    const files = openDirectory(bookmarksDocument, join(deps.root, bookmarksDocument.path));
    const loaded = new Map<string, Promise<BookmarkTree>>();
    // One change at a time per profile: each is applied and saved before the next starts.
    const queues = new Map<string, Promise<unknown>>();

    const save = async (profile: string, tree: BookmarkTree, seeded: boolean): Promise<void> => {
        const file: BookmarksFile = { profile, seeded, nodes: tree.list() };
        await files.write(fileIdOf(profile), file);
    };

    const load = async (profile: string): Promise<BookmarkTree> => {
        let file: BookmarksFile | undefined;
        try {
            file = await files.read(fileIdOf(profile));
        } catch (err) {
            // Unreadable by this build: set aside by jsonDir's own write over it, and the profile starts over.
            deps.warn({ profile, err: errorMessage(err) }, "bookmarks: unreadable, starting over");
        }
        if (file?.seeded === true) {
            return new BookmarkTree(file.nodes, now());
        }
        // Best effort: Chromium's file mid-rewrite, or in a shape this build does not read, is tried again next start.
        try {
            const seed = (await deps.chromiumBookmarks(profile, deps.mint ?? mintBookmarkId)) ?? [];
            const tree = new BookmarkTree([...(file?.nodes ?? []), ...seed], now());
            await save(profile, tree, true);
            return tree;
        } catch (err) {
            deps.warn({ profile, err: errorMessage(err) }, "bookmarks: could not read Chromium's own bookmarks");
            return new BookmarkTree(file?.nodes ?? [], now());
        }
    };

    const open = (profile: string): Promise<BookmarkTree> => {
        const opening = loaded.get(profile) ?? load(profile);
        loaded.set(profile, opening);
        return opening;
    };

    const change = <T>(profile: string, apply: (tree: BookmarkTree) => T): Promise<T> => {
        const run = async (): Promise<T> => {
            const tree = await open(profile);
            const result = apply(tree);
            await save(profile, tree, true);
            deps.changed(profile);
            return result;
        };
        const next = (queues.get(profile) ?? Promise.resolve()).then(run, run);
        // allow(silent-catch): the queue only orders the changes; each one's refusal is answered to its own caller.
        queues.set(profile, next.catch(() => undefined));
        return next;
    };

    return {
        list: async (profile) => ({ profile, nodes: (await open(profile)).list() }),
        add: (input) => change(input.profile, (tree) => tree.add(input, now(), deps.mint)),
        edit: (input) => change(input.profile, (tree) => tree.edit(input.id, input)),
        move: (input) => change(input.profile, (tree) => tree.move(input.id, input.parent, input.index)),
        remove: (profile, id) => change(profile, (tree) => tree.remove(id)),
    };
};
