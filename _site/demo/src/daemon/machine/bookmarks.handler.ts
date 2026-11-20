import { demoAddBookmark, demoBookmarks, demoEditBookmark, demoMoveBookmark, demoRemoveBookmark } from "../../fixture/browsing/bookmarks";
import { pushRuntime } from "../runtimePush";
import type { Doors } from "../doors";

// The visitor's bookmarks (fixture/bookmarks.ts), changed for the rest of the visit and pushed after every change as the
// daemon pushes the `bookmarks` domain, so a star pressed fills in everywhere the bookmarks show.
const pushed = <T>(answer: T): T => {
    pushRuntime(`bookmarks`);
    return answer;
};

export const bookmarksDoors = {
    list: ({ profile }) => demoBookmarks(profile),
    add: (input) => pushed(demoAddBookmark(input)),
    edit: (input) => pushed(demoEditBookmark(input)),
    move: (input) => pushed(demoMoveBookmark(input)),
    remove: (input) => pushed(demoRemoveBookmark(input)),
} satisfies Doors<`bookmarks`>;
