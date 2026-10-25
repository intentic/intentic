import { isAccountPath } from "./home";

// WHERE THE APP OPENS, AND WHERE A SANDBOX OPENS. Two answers since 2026-10-25, when Home (the master view, every
// sandbox at once) became the first screen: the bare address `/` lands on Home, and going INTO a sandbox (its tile's
// Open, a link naming it, a switch to one never visited) lands on that sandbox's own first screen, which is its agents
// board. Kept apart because "/" used to mean both, and an "enter this sandbox" that pushed `/` would now bounce straight
// back out to Home.

/** What the two answers read of the person's standing in the active sandbox (client/sandbox/useRole.ts). */
export interface LandingRole {
    /** The tier below viewer: talks to the persona cards it holds, and is shown nothing else of the box. */
    readonly isGuest: boolean;
    /** A guest whose only way in is its own home conversation. */
    readonly homeOnly: boolean;
}

export const HOME_PATH = `/home`;

/** A sandbox's own first screen: its agents board; a guest's chat, or a home-only guest's home. */
export const sandboxLanding = (role: LandingRole): string => {
    if (role.isGuest) {
        return role.homeOnly ? HOME_PATH : `/chat`;
    }
    return `/agents`;
};

/**
 * The bare address. Home for everyone who has one to stand on: the person's own master view, before and after their
 * first sandbox. A plain guest's way in is the chat of the box it was let into, as before. The Android app draws the
 * board itself (router/nativeHandoff.ts), so its WebView keeps opening there.
 */
export const rootLanding = (role: LandingRole, embedded: boolean): string => {
    if (embedded || (role.isGuest && !role.homeOnly)) {
        return sandboxLanding(role);
    }
    return HOME_PATH;
};

/**
 * Where opening a sandbox goes: the screen it was last left on, when that was a screen of the sandbox's own, else its
 * first screen. An account page (Home, settings) or the bare address is no screen of a sandbox.
 */
export const sandboxEntry = (remembered: string | undefined, role: LandingRole): string =>
    remembered === undefined || remembered === `/` || isAccountPath(remembered) ? sandboxLanding(role) : remembered;
