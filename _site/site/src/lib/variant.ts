import { DEFAULT_PROFILE, PROFILE_PARAM, type Profile } from "@intentic/constants";
import { APP_URL } from "@intentic/site-content/site";

// The site ships one set of pages in two skins. The dark carved-stone design is the default; `desk` is the light one,
// for readers who were sent a link and are not here to look at a terminal. Which one a visitor gets is decided in the
// browser before first paint (BaseLayout's inline script), never at the edge — one HTML document per URL stays
// cacheable, and only the `data-variant` attribute on <html> differs.
//
// A reader who has chosen neither gets the one their system asks for: `prefers-color-scheme: light` paints the desk
// skin. That is a preference, not a choice — it is never written to the cookie, so it is re-read on every page and
// follows the system when the system changes, and it hands the app nothing.
//
// The same script hands the choice on to the app, since the reader crosses to another origin the cookie below cannot
// reach. A variant is which design THIS site wears; a profile is who is arriving, which the app answers in more than
// paint (@intentic/constants profile.ts). They share their names, and this is the only place that maps one to the other.

/** Written by the pre-paint script, read by it on every later page. */
export const VARIANT_COOKIE = "variant";

/** The light skin's name, and the value of `<html data-variant>` when it is on. Any other value means the default. */
export const DESK_VARIANT = "desk" satisfies Profile;

/** Consulted only when nothing was chosen; a match paints the desk skin. */
export const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** Landing anywhere under this path turns the light skin on and remembers it. */
export const DESK_PATH = "/desk";

/** Overrides both the path and the cookie, so a link can put a reader into either skin. */
export const VARIANT_PARAM = "variant";

/** How long a skin chosen by one link survives. A year: long enough that the reader never meets the other design. */
export const VARIANT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Returns a reader to the default design and clears the cookie. The footer's way out of the light skin. */
export const DEFAULT_VARIANT_HREF = `/?${VARIANT_PARAM}=default`;

// Browser UI (Android's address bar, a PWA's title bar) is painted from this, so it has to follow the skin. The dark
// value is the canvas; the light one is the app's light canvas, `neutral-100 94% + brand-300` resolved to sRGB.
// BaseLayout ships both as media-scoped meta tags, which is what a reader with no script and no choice gets; the
// script below pins both to one colour once there IS a choice, since a choice outranks the system.
export const THEME_COLOR = { default: "#0c0907", desk: "#f5ede7" } as const;

const q = (value: string): string => JSON.stringify(value);

/**
 * The pre-paint script, as source text for BaseLayout to inline. Text rather than a module because it has to run
 * before the first paint: a second round trip would show the dark page to a reader who asked for the light one.
 * It must sit after the `theme-color` meta tag it rewrites.
 */
export const variantScript = (): string => `(function () {
    var url = new URL(window.location.href);
    var asked = url.searchParams.get(${q(VARIANT_PARAM)});
    var chosen;
    if (asked !== null) {
        chosen = asked;
    } else if (url.pathname === ${q(DESK_PATH)} || url.pathname.indexOf(${q(`${DESK_PATH}/`)}) === 0) {
        chosen = ${q(DESK_VARIANT)};
    }
    if (chosen === undefined) {
        var jar = new RegExp("(?:^|; )" + ${q(VARIANT_COOKIE)} + "=([^;]*)").exec(document.cookie);
        chosen = jar === null ? "" : decodeURIComponent(jar[1]);
    } else {
        document.cookie = ${q(`${VARIANT_COOKIE}=`)} + encodeURIComponent(chosen) +
            ";path=/;max-age=${VARIANT_COOKIE_MAX_AGE};samesite=lax";
        url.searchParams.delete(${q(VARIANT_PARAM)});
        window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    // Nothing chosen means the system decides the paint, and keeps deciding it: no cookie is written here, so a
    // reader who flips their OS to dark is dark on the next page without ever having to find the footer link.
    var light = chosen === ${q(DESK_VARIANT)} ||
        (chosen === "" && window.matchMedia(${q(LIGHT_QUERY)}).matches);
    if (light) {
        document.documentElement.dataset.variant = ${q(DESK_VARIANT)};
    }
    if (chosen !== "") {
        // Both media-scoped tags get the same colour, which is how a choice outranks the system for browser chrome.
        var color = chosen === ${q(DESK_VARIANT)} ? ${q(THEME_COLOR.desk)} : ${q(THEME_COLOR.default)};
        var tags = document.querySelectorAll('meta[name="theme-color"]');
        for (var t = 0; t < tags.length; t++) {
            tags[t].setAttribute("content", color);
        }
    }
    // An unchosen reader hands the app nothing: no cookie, no path, no link means no opinion, and the app keeps
    // whatever it already had — including a reader painted light by their system, whose system the app can read
    // for itself and whose profile is more than paint. Anything chosen that is not desk is the default, including
    // the footer's way out, which is what lets that link put the app back too.
    if (chosen === "") {
        return;
    }
    var profile = chosen === ${q(DESK_VARIANT)} ? ${q(DESK_VARIANT)} : ${q(DEFAULT_PROFILE)};
    // The pages are static and shared by both designs, so the profile is attached here rather than baked into each
    // href — the same reason the design itself is. Runs on DOMContentLoaded because this script sits in <head>,
    // above every link it rewrites.
    var carry = function () {
        var links = document.querySelectorAll("a[href]");
        for (var i = 0; i < links.length; i++) {
            var target;
            try {
                target = new URL(links[i].getAttribute("href"), window.location.href);
            } catch (e) {
                continue;
            }
            if (target.origin !== ${q(new URL(APP_URL).origin)}) {
                continue;
            }
            // set(), not an appended string: /where-it-runs hands the app a ?machine= already, and a second query
            // string would take the rung with it.
            target.searchParams.set(${q(PROFILE_PARAM)}, profile);
            links[i].setAttribute("href", target.toString());
        }
    };
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", carry);
    } else {
        carry();
    }
})();`;
