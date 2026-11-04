import type { SandboxMode } from "./sandbox-mode.js";

// A PROFILE is one named answer to "who is arriving", decided at intentic.dev and carried to the app on the link they
// click. It decides nothing by itself any more (2026-11). All it still says is which answer the app preselects when
// this reader makes a sandbox ("Who handles the code here?"), a question they see and can answer the other way.
//
// It used to seed the look and the audience into the browser, and a definition into the sandbox, which let one link
// decide every sandbox that browser would ever open. Those are now three different owners: how a sandbox runs is the
// sandbox's own setting (sandbox-mode.ts), the words follow that setting unless a person overrides them for
// themselves, and how the app looks belongs to the person and travels with their account.
//
// Here so the site, the app's pre-paint script and the platform cannot drift on the names; every value below is
// spelled somewhere that cannot import it (an inline <script>), and that place is pinned by a test that reads this
// module.

/** Names the profile on a link from the site to the app. */
export const PROFILE_PARAM = "profile";

/** Where the app remembers which profile brought this browser: read when it asks how a new sandbox should run. */
export const PROFILE_STORAGE_KEY = "ui-profile";

// The site's edition cookie. Only the site reads it now, to keep its own skin from page to page; the app stopped
// taking a profile from it in 2026-11, since a cookie nobody sees deciding how a sandbox runs is exactly what the
// creation question replaced. Still set on the registrable domain both origins share (sharedCookieDomain).
/** The site's edition cookie. */
export const PROFILE_COOKIE = "variant";

/**
 * The domain a cookie must be set on for both origins to read it, or undefined when a host-only cookie already does
 * (the same host, or hosts with no registrable domain to share: localhost, an IP).
 */
export const sharedCookieDomain = (originA: string, originB: string): string | undefined => {
    const a = new URL(originA).hostname.split(".");
    const b = new URL(originB).hostname.split(".");
    if (a.join(".") === b.join(".")) {
        return undefined;
    }
    const shared: string[] = [];
    while (a.length > 0 && b.length > 0 && a.at(-1) === b.at(-1)) {
        shared.unshift(a.pop() as string);
        b.pop();
    }
    // Two labels is the shortest registrable domain; an all-digit label means an IP, which no domain cookie covers.
    return shared.length >= 2 && shared.every((label) => !/^\d+$/u.test(label)) ? shared.join(".") : undefined;
};

/** Every profile there is, as a tuple so a schema can take it and the type below cannot drift from the list. */
export const PROFILE_IDS = ["default", "desk"] as const;

export type Profile = (typeof PROFILE_IDS)[number];

/** What a profile still says on arrival: the answer preselected where a sandbox is made, if it has one. */
export interface ProfileArrival {
    readonly mode?: SandboxMode;
}

// `default` is listed, not implied, because it is also the way back: `?profile=default` replaces a desk link's
// preselect for a reader who came back by the developer's page.
export const PROFILES: Record<Profile, ProfileArrival> = {
    default: {},
    desk: { mode: "hands-off" },
};

export const DEFAULT_PROFILE: Profile = "default";

export const isProfile = (value: unknown): value is Profile => PROFILE_IDS.includes(value as Profile);
