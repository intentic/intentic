import { type Ref, ref } from "vue";

// The browser's library as a browsers view holds it (BrowserLibrary.vue): the history page or the bookmarks manager,
// shown over whatever tab is in front until a page is picked from it or it is closed, and what a pick does is the view's
// (go there, or open it in a new tab).

export type LibraryMode = `history` | `bookmarks`;

export interface HistoryOverlay {
    readonly shown: Ref<boolean>;
    // Which of the two pages it shows.
    readonly mode: Ref<LibraryMode>;
    // What Ctrl+H and the menu's History call, and the menu's Bookmarks with `bookmarks`.
    readonly open: (mode?: LibraryMode) => void;
    readonly close: () => void;
    readonly pick: (url: string, newTab: boolean) => void;
}

export const useHistoryOverlay = (go: (url: string, newTab: boolean) => void): HistoryOverlay => {
    const shown = ref(false);
    const mode = ref<LibraryMode>(`history`);
    return {
        shown,
        mode,
        open: (which = `history`) => {
            mode.value = which;
            shown.value = true;
        },
        close: () => {
            shown.value = false;
        },
        pick: (url, newTab) => {
            shown.value = false;
            go(url, newTab);
        },
    };
};
