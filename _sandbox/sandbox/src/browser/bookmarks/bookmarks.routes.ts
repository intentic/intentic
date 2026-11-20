import { bookmarksContract } from "@intentic/sandbox-contract/contracts/bookmarks.contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { publishRuntimeChange } from "../../seams/runtime-feed.js";
import { sessionDir } from "../sessions/session-store.js";
import { ANONYMOUS_BROWSER_SERVER } from "../tools/browser-servers.js";
import { BookmarkRefusal } from "./bookmark-tree.js";
import { type BookmarksStore, bookmarksStore } from "./bookmarks-store.js";
import { readChromiumBookmarks } from "./chromium-bookmarks.js";

// A refused change as the caller is told it: a bookmark or folder that is not there, or a change the tree will not take
// (a folder into itself, a root moved).
const answered = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
        return await work();
    } catch (err) {
        if (err instanceof BookmarkRefusal) {
            throw new ORPCError(err.missing ? "NOT_FOUND" : "BAD_REQUEST", { message: err.message });
        }
        throw err;
    }
};

/* The `bookmarks.*` procedures over a store. */
const bookmarksRoutes = (store: BookmarksStore) => {
    const i = implement(bookmarksContract).$context<OrpcContext>();
    return {
        list: i.list.handler(({ input }) => store.list(input.profile)),
        add: i.add.handler(({ input }) => answered(async () => ({ node: await store.add(input) }))),
        edit: i.edit.handler(({ input }) => answered(async () => ({ node: await store.edit(input) }))),
        move: i.move.handler(({ input }) => answered(async () => ({ node: await store.move(input) }))),
        remove: i.remove.handler(({ input }) =>
            answered(async () => {
                await store.remove(input.profile, input.id);
                return {};
            }),
        ),
    };
};

/* The routes over the workspace's own store, every change pushed as the `bookmarks` runtime domain. */
export const createBookmarksRoutes = (services: Pick<Services, "workspace" | "logger">) => {
    const root = services.workspace.root;
    return bookmarksRoutes(
        bookmarksStore({
            root,
            // Only a persistent profile has bookmarks of its own: the agents' credential-free browser runs on none.
            chromiumBookmarks: (profile, mint) =>
                profile === ANONYMOUS_BROWSER_SERVER ? Promise.resolve(undefined) : readChromiumBookmarks(sessionDir(root, profile), Date.now(), mint),
            changed: () => publishRuntimeChange("bookmarks"),
            warn: (problem, message) => services.logger.warn(problem, message),
        }),
    );
};
