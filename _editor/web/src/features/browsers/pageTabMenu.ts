import type { BrowserClosedTab, BrowserPage } from "@intentic/sandbox-contract/schemas/terminal";
import type { MenuItem } from "primevue/menuitem";

// A web page tab's own menu, as a browser's right-click on a tab offers it: reload, a copy beside it, mute, copy its
// address, then the closes (it, the others, the ones after it), then bringing a closed one back (the last, or one of the
// recently closed by name). What each row does is the caller's; this decides only which rows a tab has and what they
// say. A row that would do nothing (close the others of a lone tab, reopen with nothing closed) is left out rather than
// greyed, so the menu stays short.

export interface TabMenuActions {
    readonly reload: () => void;
    readonly duplicate: () => void;
    // Present where the window can mute a tab (the person's own window); absent, the row is not offered.
    readonly mute?: ((muted: boolean) => void) | undefined;
    readonly copyAddress: () => void;
    readonly close: () => void;
    readonly closeOthers: () => void;
    readonly closeRight: () => void;
    // One closed tab by its id, or the last one closed.
    readonly reopen: (closedId?: string) => void;
}

export interface TabMenuWords {
    readonly reload: string;
    readonly duplicate: string;
    readonly mute: string;
    readonly unmute: string;
    readonly copyAddress: string;
    readonly close: string;
    readonly closeOthers: string;
    readonly closeRight: string;
    readonly reopen: string;
    readonly recentlyClosed: string;
}

const BLANK = `about:blank`;

// A closed tab's row: its title, else its site.
const closedLabel = (tab: BrowserClosedTab): string => {
    if (tab.title !== undefined && tab.title !== ``) {
        return tab.title;
    }
    return URL.canParse(tab.url) ? new URL(tab.url).host : tab.url;
};

export const tabMenu = (input: {
    readonly page: BrowserPage;
    // The window's open tabs, in strip order.
    readonly pages: readonly BrowserPage[];
    readonly closed: readonly BrowserClosedTab[];
    readonly words: TabMenuWords;
    readonly act: TabMenuActions;
}): MenuItem[] => {
    const { page, pages, closed, words, act } = input;
    const at = pages.findIndex((listed) => listed.id === page.id);
    const hasAddress = page.url !== `` && page.url !== BLANK;
    const canMute = act.mute !== undefined && (page.audible !== undefined || page.muted !== undefined);
    const muted = page.muted === true;
    const items: MenuItem[] = [
        { label: words.reload, icon: `refresh`, command: act.reload },
        ...(hasAddress ? [{ label: words.duplicate, icon: `clone`, command: act.duplicate }] : []),
        ...(canMute ? [{ label: muted ? words.unmute : words.mute, icon: muted ? `volume-up` : `volume-off`, command: () => act.mute?.(!muted) }] : []),
        ...(hasAddress ? [{ label: words.copyAddress, icon: `copy`, command: act.copyAddress }] : []),
        { separator: true },
        { label: words.close, icon: `times`, command: act.close },
        ...(pages.length > 1 ? [{ label: words.closeOthers, command: act.closeOthers }] : []),
        ...(at >= 0 && at < pages.length - 1 ? [{ label: words.closeRight, command: act.closeRight }] : []),
    ];
    if (closed.length === 0) {
        return items;
    }
    return [
        ...items,
        { separator: true },
        { label: words.reopen, icon: `undo`, command: () => act.reopen() },
        {
            label: words.recentlyClosed,
            icon: `history`,
            items: closed.map((tab) => ({ label: closedLabel(tab), hint: tab.url, command: () => act.reopen(tab.id) })),
        },
    ];
};
