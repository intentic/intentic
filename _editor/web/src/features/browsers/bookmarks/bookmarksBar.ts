import { computed, type ComputedRef, type Ref, ref } from "vue";
import type { BrowserSession } from "@intentic/sandbox-contract/schemas/terminal";
import { storedValue, storeValue } from "../../../app/storage/browserStorage";
import { type PageMarks, pageMarks } from "./bookmarkTree";
import { useBookmarks } from "./useBookmarks";

// Whether the bookmarks bar shows under the toolbar: off until asked for (the menu, Ctrl+Shift+B), and remembered on
// this device rather than for the account, since a narrow laptop and a wide desk screen want different answers. One
// switch for every browsers view of the page.

const KEY = `intentic-browsers-bookmarks-bar`;

export const bookmarksBarShown: Ref<boolean> = ref(storedValue(KEY) === `on`);

export const toggleBookmarksBar = (): void => {
    bookmarksBarShown.value = !bookmarksBarShown.value;
    storeValue(KEY, bookmarksBarShown.value ? `on` : `off`);
};

/** What the address bar marks pages with: the person's bookmarks, and each site's icon from the tabs open now. */
export const usePageMarks = (windows: Ref<readonly BrowserSession[]>): ComputedRef<PageMarks> => {
    const { nodes } = useBookmarks();
    return computed(() => pageMarks(nodes.value, windows.value.flatMap((window) => window.pages)));
};
