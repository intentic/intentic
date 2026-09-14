// A TEMPORARY TYPE LAB. The reading face is being chosen, so the site can wear nine of them and the choice is a
// click. Everything here — the catalogue, the switcher component, the cookie — is meant to be deleted once a face
// wins; what survives is one `--font-sans` line in global.css.
//
// The brief: Mukta sets too light at body sizes, so every candidate is picked for weight on the page rather than
// personality — humanist or neutral, high x-height, and a 400 that still looks like ink at 15px. Each one really
// has 400/500/600, because the site sets all three (body, control labels, small-caps labels) and a missing weight
// gets synthesised into a smear.
//
// The eight alternatives load from Google's CDN on demand: a face nobody picked costs nothing, and a face being
// tried costs one request. The winner should then be self-hosted in public/fonts/ like Mukta, which is why Mukta
// is the only one here with no `google` entry.

export interface Typeface {
    /** The `data-font` value, the cookie value, and the `?font=` value. */
    id: string;
    label: string;
    /** What `--font-sans` becomes. */
    stack: string;
    /** The Google Fonts stylesheet, or undefined for the face the site already self-hosts. */
    google?: string;
    /** One line on what it is and why it is a candidate. */
    note: string;
}

const TAIL = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"`;
const sheet = (family: string, weights = "400;500;600"): string =>
    `https://fonts.googleapis.com/css2?family=${family}:wght@${weights}&display=swap`;

export const TYPEFACES: Typeface[] = [
    { id: "mukta", label: "Mukta", stack: `"Mukta", ${TAIL}`, note: "what the site ships today — the one being replaced" },
    { id: "inter", label: "Inter", stack: `"Inter", ${TAIL}`, google: sheet("Inter"), note: "the neutral workhorse: tall x-height, nothing to argue with" },
    {
        id: "source-sans",
        label: "Source Sans 3",
        stack: `"Source Sans 3", ${TAIL}`,
        google: sheet("Source+Sans+3"),
        note: "humanist and warm; reads long without going bland",
    },
    {
        id: "plex-sans",
        label: "IBM Plex Sans",
        stack: `"IBM Plex Sans", ${TAIL}`,
        google: sheet("IBM+Plex+Sans"),
        note: "humanist with real character — the most opinionated of the eight",
    },
    { id: "work-sans", label: "Work Sans", stack: `"Work Sans", ${TAIL}`, google: sheet("Work+Sans"), note: "geometric-humanist, noticeably sturdier at 400" },
    {
        id: "nunito-sans",
        label: "Nunito Sans",
        stack: `"Nunito Sans", ${TAIL}`,
        google: sheet("Nunito+Sans"),
        note: "soft terminals; the closest match to Baloo 2's roundness",
    },
    { id: "figtree", label: "Figtree", stack: `"Figtree", ${TAIL}`, google: sheet("Figtree"), note: "friendly and modern, with a heavier default colour on the page" },
    { id: "rubik", label: "Rubik", stack: `"Rubik", ${TAIL}`, google: sheet("Rubik"), note: "slightly rounded corners, wide apertures, very solid at small sizes" },
    {
        id: "public-sans",
        label: "Public Sans",
        stack: `"Public Sans", ${TAIL}`,
        google: sheet("Public+Sans"),
        note: "drawn for government forms: legibility first, ornament never",
    },
];

/** The face the site wears when nothing is chosen, and the one that needs no download. */
export const DEFAULT_TYPEFACE = TYPEFACES[0]!;

export const FONT_COOKIE = "font";
export const FONT_PARAM = "font";
export const FONT_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/** The `data-font` rules, built from the catalogue so the list above is the only place a face is named. */
export const typefaceCss = (): string =>
    TYPEFACES.filter((face) => face.id !== DEFAULT_TYPEFACE.id)
        .map((face) => `html[data-font="${face.id}"]{--font-sans:${face.stack};}`)
        .join("");

const q = (value: string): string => JSON.stringify(value);

/**
 * Applies the chosen face before first paint, and pulls its stylesheet only if it is actually being worn.
 * Same shape as the variant script in variant.ts, and for the same reason: a second round trip would show the
 * page in the old face first.
 */
export const typefaceScript = (): string => {
    const sheets = Object.fromEntries(TYPEFACES.filter((face) => face.google !== undefined).map((face) => [face.id, face.google]));
    return `(function () {
    var sheets = ${JSON.stringify(sheets)};
    var url = new URL(window.location.href);
    var asked = url.searchParams.get(${q(FONT_PARAM)});
    var chosen;
    if (asked !== null) {
        chosen = asked;
        document.cookie = ${q(`${FONT_COOKIE}=`)} + encodeURIComponent(chosen) +
            ";path=/;max-age=${FONT_COOKIE_MAX_AGE};samesite=lax";
        url.searchParams.delete(${q(FONT_PARAM)});
        window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    } else {
        var jar = new RegExp("(?:^|; )" + ${q(FONT_COOKIE)} + "=([^;]*)").exec(document.cookie);
        chosen = jar === null ? "" : decodeURIComponent(jar[1]);
    }
    if (chosen === "" || chosen === ${q(DEFAULT_TYPEFACE.id)}) {
        return;
    }
    document.documentElement.dataset.font = chosen;
    var href = sheets[chosen];
    if (href !== undefined) {
        var link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        document.head.appendChild(link);
    }
})();`;
};
