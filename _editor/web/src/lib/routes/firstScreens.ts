import { homePath, insidePath, isSandboxPage, legacyTarget, page, parseAppPath } from "@intentic/sandbox-contract/app-routes";

// WHERE THE APP OPENS, AND WHERE A SANDBOX OPENS. Two answers since 2026-10-25, when Home (the master view, every
// sandbox at once) became the first screen: the bare address `/` lands on Home, and going INTO a sandbox (its tile's
// Open, a link naming it, a switch to one never visited) lands on that sandbox's own first screen, which is its agents
// board. Kept apart because "/" used to mean both, and an "enter this sandbox" that pushed `/` would now bounce straight
// back out to Home. Both are addresses of the sandbox's own since 2026-11-04 (`/s/<sandbox>/agents`), so each answer
// names the sandbox it is about.

/** What the two answers read of the person's standing in the sandbox (client/sandbox/useRole.ts). */
export interface LandingRole {
    /** The tier below viewer: talks to the persona cards it holds, and is shown nothing else of the box. */
    readonly isGuest: boolean;
    /** A guest whose only way in is its own home conversation. */
    readonly homeOnly: boolean;
}

export const HOME_PATH = homePath();

/** A sandbox's own first screen: its agents board; a guest's chat, or a home-only guest's home. */
export const sandboxLanding = (sandbox: string, role: LandingRole): string => {
    if (role.isGuest) {
        return role.homeOnly ? homePath(sandbox) : insidePath(sandbox, page.chat());
    }
    return insidePath(sandbox, page.agents());
};

/**
 * The bare address. Home for everyone who has one to stand on: the person's own master view, before and after their
 * first sandbox. A plain guest's way in is the chat of the box it was let into, as before. The Android app draws the
 * board itself (router/nativeHandoff.ts), so its WebView keeps opening there. With no sandbox to open, Home it is.
 */
export const rootLanding = (role: LandingRole, embedded: boolean, sandbox: string | undefined): string => {
    if (sandbox !== undefined && (embedded || (role.isGuest && !role.homeOnly))) {
        return sandboxLanding(sandbox, role);
    }
    return HOME_PATH;
};

/**
 * A screen of a sandbox, as its address inside that sandbox: one already there, or one written before frames (an older
 * build's memory, or a caller that still names the page that way) read as that sandbox's. An account page, Home, the
 * bare address or another sandbox's page is no screen of this one.
 */
export const insideScreen = (sandbox: string, address: string): string | undefined => {
    const parsed = parseAppPath(address);
    if (parsed !== undefined) {
        const shown = parsed.page?.name;
        return parsed.frame.kind === `inside` && parsed.frame.sandbox === sandbox && shown !== undefined && isSandboxPage(shown)
            ? address
            : undefined;
    }
    const legacy = legacyTarget(address);
    return legacy === undefined || legacy.frame !== `inside` ? undefined : insidePath(sandbox, legacy.link);
};

/** Where opening a sandbox goes: the screen it was last left on, when that was a screen of its own, else its first screen. */
export const sandboxEntry = (sandbox: string, remembered: string | undefined, role: LandingRole): string =>
    (remembered === undefined ? undefined : insideScreen(sandbox, remembered)) ?? sandboxLanding(sandbox, role);
