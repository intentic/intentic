// A PROFILE is one named answer to "who is arriving", decided at intentic.dev and carried to the app on the link they
// click. It has three halves and they land in three different stores, because they have three different lifetimes: the
// look and the audience are facts about a browser (localStorage, seeded before first paint), and the sandbox defaults
// are facts about a sandbox (a definition seed applied once, at its first boot).
//
// Here so the site, the app's pre-paint script and the platform cannot drift on the names; every value below is
// spelled somewhere that cannot import it (an inline <script>, a TOML file), and each of those places is pinned by a
// test that reads this module.

/** Names the profile on a link from the site to the app. */
export const PROFILE_PARAM = "profile";

/** Where the app remembers which profile brought this browser; read long after the link that carried it is gone. */
export const PROFILE_STORAGE_KEY = "ui-profile";

// THE COOKIE IS THE SECOND WAY A PROFILE REACHES THE APP, and the only one that survives an installer. The site
// writes it on the registrable domain both origins share (sharedCookieDomain), so app.intentic.dev reads it too: a
// reader who took the desktop app from intentic.dev/maker never clicked a link into the app, and the sign-in page the
// app opens in their browser is the first thing on the app's origin they meet. `maker` means the maker profile; any
// other value is the site's way out, which is the default profile; absent is no opinion.
/** The site's edition cookie, readable by the app. */
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
export const PROFILE_IDS = ["default", "maker"] as const;

export type Profile = (typeof PROFILE_IDS)[number];

// `system` is the stored spelling of "nobody has chosen": the scheme follows `prefers-color-scheme` and the skin
// follows the scheme. It is a value rather than an absence so a profile can hand a browser back to it.
export type ProfileScheme = "system" | "light" | "dark";
export type ProfileSkin = "system" | "none" | "sanctum";
export type ProfileAudience = "developer" | "maker";

/** The localStorage keys a profile seeds, each owned by the composable named beside it. */
export const PROFILE_KEYS = {
    // _editor/ui/src/composables/useTheme.ts
    scheme: "ui-color-scheme",
    // _editor/web/src/skins/useSkin.ts
    skin: "ui-skin",
    // _editor/web/src/app/useAudience.ts
    audience: "ui-audience",
} as const;

export interface ProfileLook {
    readonly scheme: ProfileScheme;
    readonly skin: ProfileSkin;
    // Absent means the profile does not answer it: AudienceAsk still asks, which is what `default` wants.
    readonly audience?: ProfileAudience;
}

// `default` is listed, not implied, because it is also the way back: a profile may overwrite what the last profile
// wrote, so `?profile=default` undoes a maker link for anyone who has not since chosen for themselves.
export const PROFILES: Record<Profile, ProfileLook> = {
    default: { scheme: "system", skin: "system" },
    maker: { scheme: "light", skin: "none", audience: "maker" },
};

export const DEFAULT_PROFILE: Profile = "default";

export const isProfile = (value: unknown): value is Profile => PROFILE_IDS.includes(value as Profile);
