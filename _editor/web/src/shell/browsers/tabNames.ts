import type { BrowserPage, BrowserSession } from "@intentic/sandbox-contract/schemas/terminal";
import { t } from "@intentic/ui/i18n";
import { computed, type Ref, watch } from "vue";
import { activePageOf } from "../../features/browsers/activePage";
import type { StripTab } from "../../features/browsers/stripTab";
import type { PinnedTab } from "../../workbench/browsers/browsersPaths";
import { browsersTabNames, type BrowsersTabName } from "../../workbench/browsers/browsersSurface";

// What the Browsers view calls its pages and tabs: a page's text on the strip, and every tab's name as the side tabs that
// stand for them beside the section say it (browsersTabNames), since only the mounted view reads the apps and windows.

export const BLANK = `about:blank`;

const hostOf = (url: string): string => {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
};

// A tab's text: title, else host, else raw url, the same ladder the daemon uses for the session label, so a tab and
// its window row never disagree. A page with none of them is a fresh tab, and says so.
export const pageLabel = (page: BrowserPage): string => {
    if (page.title !== undefined && page.title !== ``) {
        return page.title;
    }
    if (page.url === `` || page.url === BLANK) {
        return t(`browsers.browsers.newTab`);
    }
    return hostOf(page.url) || page.url;
};

export interface TabNameSources {
    // The window whose pages are shown, and the page picked in it.
    readonly current: Ref<BrowserSession | undefined>;
    readonly pickedPage: Ref<string | undefined>;
    // The view draws its own new-tab page over the window in front.
    readonly newTabPage: Ref<boolean>;
    readonly windows: Ref<readonly BrowserSession[]>;
    readonly pinned: Ref<readonly PinnedTab[]>;
    readonly pinTab: (pin: PinnedTab) => StripTab;
    readonly windowName: (session: BrowserSession) => string;
}

// Publishes every tab's name for as long as the view is mounted: a pin as its own tab says, a web window as its page in
// front, and the web as it stands as the page in front of the window shown.
export const publishTabNames = ({ current, pickedPage, newTabPage, windows, pinned, pinTab, windowName }: TabNameSources): void => {
    const windowTabName = (session: BrowserSession | undefined): BrowsersTabName => {
        const shown = session !== undefined && session.name === current.value?.name;
        const page = session === undefined ? undefined : activePageOf(session.pages, shown ? pickedPage.value : undefined);
        return {
            title: page === undefined || (shown && newTabPage.value) ? t(`browsers.browsers.newTab`) : pageLabel(page),
            note: session === undefined ? undefined : windowName(session),
        };
    };
    const names = computed<ReadonlyMap<string, BrowsersTabName>>(
        () =>
            new Map<string, BrowsersTabName>([
                [``, windowTabName(current.value)],
                ...windows.value.map((session): [string, BrowsersTabName] => [session.name, windowTabName(session)]),
                ...pinned.value.map((pin): [string, BrowsersTabName] => {
                    const tab = pinTab(pin);
                    return [tab.id, { title: tab.label, note: tab.note }];
                }),
            ]),
    );
    watch(
        names,
        (next) => {
            browsersTabNames.value = next;
        },
        { immediate: true },
    );
};
