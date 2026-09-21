import { DEFAULT_PROFILE, PROFILE_COOKIE, PROFILE_PARAM, type Profile, sharedCookieDomain } from "@intentic/constants";
import { APP_URL, MAKER_PATH as MAKER_PAGE, SITE_URL } from "@intentic/site-content/site";

// Two products share one site. The developer's pages are the dark carved-stone design; intentic maker, the product
// for readers who do not write code, has its own page at /maker/ (MakerLanding.astro) and wears the light skin. What
// the skin decides is the LOOK of the shared pages (docs, pricing, features) for a reader who came in through the
// maker; the words of the two product pages are each page's own, by URL, never switched here. Which skin a visitor
// gets is decided in the browser before first paint (BaseLayout's inline script), never at the edge — one HTML
// document per URL stays cacheable, and only the `data-variant` attribute on <html> differs.
//
// A reader who has chosen neither gets the one their system asks for: `prefers-color-scheme: light` paints the maker
// skin. That is a preference, not a choice — it is never written to the cookie, so it is re-read on every page and
// follows the system when the system changes, and it hands the app nothing.
//
// The same script hands the choice on to the app twice over. Once on every link into it, since the reader crosses to
// another origin; and once through the cookie itself, which is set on the domain both origins share so the app reads
// it on any arrival the links could not have carried — the desktop app's sign-in page opening in this browser after
// an installer taken from here. A variant is which design THIS site wears; a profile is who is arriving, which the app
// answers in more than paint (@intentic/constants profile.ts). They share their names, and this is the only place
// that maps one to the other.

/** Written by the pre-paint script, read by it on every later page, and by the app's on the same domain. */
export const VARIANT_COOKIE = PROFILE_COOKIE;

// The domain the cookie is written on, so the app's origin reads it too. Decided in the browser rather than baked
// in: the same built script runs on localhost and on a preview host, where a cookie naming intentic.dev is refused
// outright and the skin would be lost between pages — there a host-only cookie already reaches the app (ports do not
// scope cookies), so the attribute is left off.
const COOKIE_DOMAIN = sharedCookieDomain(SITE_URL, APP_URL) ?? "";

/** The light skin's name, and the value of `<html data-variant>` when it is on. Any other value means the default. */
export const MAKER_VARIANT = "maker" satisfies Profile;

/** Consulted only when nothing was chosen; a match paints the maker skin. */
export const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** Landing on the maker product's page, or anywhere under it, turns the light skin on and remembers it. */
export const MAKER_PATH = MAKER_PAGE.replace(/\/$/u, "");

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
export const THEME_COLOR = { default: "#0c0907", maker: "#f5ede7" } as const;

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
    } else if (url.pathname === ${q(MAKER_PATH)} || url.pathname.indexOf(${q(`${MAKER_PATH}/`)}) === 0) {
        chosen = ${q(MAKER_VARIANT)};
    }
    if (chosen === undefined) {
        var jar = new RegExp("(?:^|; )" + ${q(VARIANT_COOKIE)} + "=([^;]*)").exec(document.cookie);
        chosen = jar === null ? "" : decodeURIComponent(jar[1]);
    } else {
        var domain = ${q(COOKIE_DOMAIN)};
        var scoped = domain !== "" && (location.hostname === domain || location.hostname.endsWith("." + domain)) ? ";domain=" + domain : "";
        document.cookie = ${q(`${VARIANT_COOKIE}=`)} + encodeURIComponent(chosen) +
            ";path=/;max-age=${VARIANT_COOKIE_MAX_AGE};samesite=lax" + scoped;
        url.searchParams.delete(${q(VARIANT_PARAM)});
        window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    // Nothing chosen means the system decides the paint, and keeps deciding it: no cookie is written here, so a
    // reader who flips their OS to dark is dark on the next page without ever having to find the footer link.
    var light = chosen === ${q(MAKER_VARIANT)} ||
        (chosen === "" && window.matchMedia(${q(LIGHT_QUERY)}).matches);
    if (light) {
        document.documentElement.dataset.variant = ${q(MAKER_VARIANT)};
    }
    if (chosen !== "") {
        // Both media-scoped tags get the same colour, which is how a choice outranks the system for browser chrome.
        var color = chosen === ${q(MAKER_VARIANT)} ? ${q(THEME_COLOR.maker)} : ${q(THEME_COLOR.default)};
        var tags = document.querySelectorAll('meta[name="theme-color"]');
        for (var t = 0; t < tags.length; t++) {
            tags[t].setAttribute("content", color);
        }
    }
    // An unchosen reader hands the app nothing: no cookie, no path, no link means no opinion, and the app keeps
    // whatever it already had — including a reader painted light by their system, whose system the app can read
    // for itself and whose profile is more than paint. Anything chosen that is not maker is the default, including
    // the footer's way out, which is what lets that link put the app back too.
    if (chosen === "") {
        return;
    }
    var profile = chosen === ${q(MAKER_VARIANT)} ? ${q(MAKER_VARIANT)} : ${q(DEFAULT_PROFILE)};
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
        // A maker reader's way home is the maker's page: the mark on a shared page leads there rather than to the
        // developer's. The maker page's own mark already does (Nav.astro), so this is only ever a change on shared ones.
        if (profile === ${q(MAKER_VARIANT)}) {
            var marks = document.querySelectorAll("a[data-brand]");
            for (var m = 0; m < marks.length; m++) {
                marks[m].setAttribute("href", ${q(MAKER_PAGE)});
            }
        }
    };
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", carry);
    } else {
        carry();
    }
})();`;
