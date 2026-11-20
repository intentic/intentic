import { procedure } from "../protocol/route-meta.js";
import {
    BookmarkAddSchema,
    BookmarkChangedSchema,
    BookmarkEditSchema,
    BookmarkMoveSchema,
    BookmarkRemoveSchema,
    BookmarksQuerySchema,
    BookmarksSchema,
} from "../schemas/bookmarks.js";

// What a browser profile keeps on purpose (schemas/bookmarks.ts), read whole since a tree is small; every change is
// pushed as the `bookmarks` runtime domain, so every star, bar and manager open on the profile moves at once. The box
// itself, like the browsers they belong to (system.contract.ts): no control token reaches them, and only a maintainer,
// who may drive the browser, reads or changes what it keeps.
const bookmarksRoute = procedure.meta({ control: "never", floor: "maintainer" });

export const bookmarksContract = {
    list: bookmarksRoute
        .route({
            method: "GET",
            path: "/bookmarks",
            summary: "A browser's bookmarks",
            description:
                "Every bookmark and folder one of the sandbox's browser profiles keeps, in their folders and order: the bookmarks bar, and everything else. Your own window's are `_own`; the first read takes in what Chromium itself kept in that profile.",
        })
        .input(BookmarksQuerySchema)
        .output(BookmarksSchema),
    add: bookmarksRoute
        .route({
            method: "POST",
            path: "/bookmarks",
            summary: "Bookmark a page, or make a folder",
            description: "Adds a bookmark, or a new folder, to one of a profile's folders: at the end, or at the place given.",
        })
        .input(BookmarkAddSchema)
        .output(BookmarkChangedSchema),
    edit: bookmarksRoute
        .route({
            method: "POST",
            path: "/bookmarks/edit",
            summary: "Rename a bookmark or change where it goes",
            description: "Changes a bookmark's name or address, or a folder's name, and can move either into another folder, at its end.",
        })
        .input(BookmarkEditSchema)
        .output(BookmarkChangedSchema),
    move: bookmarksRoute
        .route({
            method: "POST",
            path: "/bookmarks/move",
            summary: "Move a bookmark or folder",
            description:
                "Puts a bookmark or a folder at a place in a folder, the one it is in or another. A folder cannot go inside itself, and the two roots stay where they are.",
        })
        .input(BookmarkMoveSchema)
        .output(BookmarkChangedSchema),
    remove: bookmarksRoute
        .route({
            method: "POST",
            path: "/bookmarks/remove",
            summary: "Remove a bookmark or folder",
            description: "Removes a bookmark, or a folder with everything in it. Removing one already gone answers the same.",
        })
        .input(BookmarkRemoveSchema)
        .output(BookmarkChangedSchema),
};
