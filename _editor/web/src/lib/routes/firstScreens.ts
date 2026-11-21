import { homePath, isSandboxPage, legacyTarget, page, type PageName, parseAppPath } from "@intentic/sandbox-contract/app-routes";
import { sandboxOfAddress, toHome, toInside } from "./links";

// WHERE THE APP OPENS, AND WHERE A SANDBOX OPENS. Two answers since 2026-10-25, when Home (the master view, every
// sandbox at once) became the first screen: the bare address `/` lands on Home, and going INTO a sandbox (its tile's
// Open, a link naming it, a switch to one never visited) lands on that sandbox's own first screen, which is its agents
// board. Kept apart because "/" used to mean both, and an "enter this sandbox" that pushed `/` would now bounce straight
// back out to Home. Both are addresses of the sandbox's own since 2026-11-04 (`/s/<sandbox>/agents`), so each answer
// names the sandbox it is about.

/** What the two answers read of the person's standing in the sandbox (client/sandbox/useTier.ts). */
export interface LandingTier {
    /** The tier below viewer: talks to the role cards it holds, and is shown nothing else of the box. */
    readonly isGuest: boolean;
    /** A guest whose only way in is its own home conversation. */
    readonly homeOnly: boolean;
}

export const HOME_PATH = homePath();

/** A sandbox's own first screen: its agents board; a guest's chat, or a home-only guest's home. */
export const sandboxLanding = (sandbox: string, tier: LandingTier): string => {
    if (tier.isGuest) {
        return tier.homeOnly ? toHome(sandbox) : toInside(sandbox, page.chat());
    }
    return toInside(sandbox, page.agents());
};

/**
 * The bare address. On a desktop, Home for everyone who has one to stand on: the person's own master view, before and
 * after their first sandbox. A plain guest's way in is the chat of the box it was let into, as before. A phone opens
 * inside the sandbox open last, on its board with the rail down its side (2026-11-21): there Home is a list of
 * sandboxes and nothing else, a screen the desktop's rail folded away on 2026-11-09, and the owner opening the app on a
 * phone wants the rail and the chats. The Android app draws the board itself (router/nativeHandoff.ts), so its WebView
 * opens there too. With no sandbox to open, Home it is, a phone's included: its list is where one is picked.
 */
export const rootLanding = (tier: LandingTier, boardFirst: boolean, sandbox: string | undefined): string => {
    if (sandbox !== undefined && (boardFirst || (tier.isGuest && !tier.homeOnly))) {
        return sandboxLanding(sandbox, tier);
    }
    return HOME_PATH;
};

/**
 * Whether a page is one a sandbox is opened back onto: any page of the sandbox's own but the phone's Menu. The Menu is
 * the rail's contents laid out as a page, and the place a sandbox is left from (another sandbox picked, the way back to
 * Home), so it was nearly always the screen kept. Opened back onto it, "Open <sandbox>" under Home's chat showed the
 * list of sandboxes with that one marked, and the Menu's back arrow stepped back to the chat: a loop with no way in
 * (2026-11-21).
 */
export const isScreen = (name: PageName): boolean => isSandboxPage(name) && name !== `menu`;

/**
 * A screen of a sandbox, as its address inside that sandbox: one already there, or one written before frames (an older
 * build's memory, or a caller that still names the page that way) read as that sandbox's. An account page, Home, the
 * bare address, the phone's Menu or another sandbox's page is no screen of this one.
 */
export const insideScreen = (sandbox: string, address: string): string | undefined => {
    const parsed = parseAppPath(address);
    if (parsed !== undefined) {
        const shown = parsed.page?.name;
        return parsed.frame.kind === `inside` && sandboxOfAddress(parsed.frame.sandbox) === sandbox && shown !== undefined && isScreen(shown)
            ? address
            : undefined;
    }
    const legacy = legacyTarget(address);
    return legacy === undefined || legacy.frame !== `inside` || !isScreen(legacy.link.page) ? undefined : toInside(sandbox, legacy.link);
};

/** Where opening a sandbox goes: the screen it was last left on, when that was a screen of its own, else its first screen. */
export const sandboxEntry = (sandbox: string, remembered: string | undefined, tier: LandingTier): string =>
    (remembered === undefined ? undefined : insideScreen(sandbox, remembered)) ?? sandboxLanding(sandbox, tier);
