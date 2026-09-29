import { t } from "@intentic/ui/i18n";
import { showTabIcon } from "./tabIcon";
import { type TabMark, tabTitle } from "./tabSignal";

// The one writer of document.title and the tab's icon in a main window. The router names the page (setPageTitle) and
// the fleet the mark (browserTab.ts); a popped-out panel's window names itself (FloatingSection.vue).

// The page the router last named, and the mark last shown: plain, since nothing reads them but the writer below.
let page: string | undefined;
let mark: TabMark | undefined;

const write = (): void => {
    const title = tabTitle(page, mark, t(`shell.browserTab.offline`));
    // Only a real change: a browser marks a background tab whose title was set, even to what it already said.
    if (document.title !== title) {
        document.title = title;
    }
    showTabIcon(mark);
};

/** The router's half: the page's own name, in the reader's language, or undefined for the bare brand. */
export const setPageTitle = (title: string | undefined): void => {
    page = title;
    write();
};

export const setTabMark = (next: TabMark | undefined): void => {
    mark = next;
    write();
};
