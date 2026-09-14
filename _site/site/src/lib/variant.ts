// The site ships one set of pages in two skins. The dark carved-stone design is the default; `desk` is the light one,
// for readers who were sent a link and are not here to look at a terminal. Which one a visitor gets is decided in the
// browser before first paint (BaseLayout's inline script), never at the edge — one HTML document per URL stays
// cacheable, and only the `data-variant` attribute on <html> differs.

/** Written by the pre-paint script, read by it on every later page. */
export const VARIANT_COOKIE = "variant";

/** The light skin's name, and the value of `<html data-variant>` when it is on. Any other value means the default. */
export const DESK_VARIANT = "desk";

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
    if (chosen === ${q(DESK_VARIANT)}) {
        document.documentElement.dataset.variant = ${q(DESK_VARIANT)};
        var themeColor = document.querySelector('meta[name="theme-color"]');
        if (themeColor !== null) {
            themeColor.setAttribute("content", ${q(THEME_COLOR.desk)});
        }
    }
})();`;
