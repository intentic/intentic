// A TEMPORARY TYPE LAB, now on two axes: the reading face and the display face. Everything here — the catalogues,
// the switcher component, the cookies, public/fonts/lab/ — is meant to be deleted once both are settled; what
// survives is two lines in global.css.
//
// The reading face is already settled: PUBLIC SANS, chosen off this lab and now self-hosted in public/fonts/ with
// the full subsets the site's own faces carry. Mukta is gone — it set too light at body sizes, which is what
// started this. The seven alternatives below stay only so the choice can be re-tested against a new display face,
// because a pairing is what is being judged now, not a face on its own.
//
// The display face is what the headline beats are set in — "You delegate." / "Agents work." / "You approve." — and
// it is the one still open. Playfair is the incumbent.
//
// Every candidate is SELF-HOSTED, in public/fonts/lab/. The lab used to pull a face from Google's CDN the moment
// you picked it, which works on a machine that can reach fonts.gstatic.com and silently does nothing on one that
// cannot. The `google` entries are read by scripts/type-lab-fonts.mts alone, at build time; nothing asks for them
// at runtime. A face the site already hosts has none.

export interface Face {
    /** The `data-*` value, the cookie value, and the `?…=` value. */
    id: string;
    label: string;
    /** What the axis's custom property becomes. */
    stack: string;
    /** Where the generator fetches this face from. Build-time only — no page ever requests this. */
    google?: string;
    /** One line on what it is and why it is a candidate. */
    note: string;
    /**
     * The weight the display rule should use. Several display serifs ship ONE weight, and asking a 400-only face
     * for 600 gets it smeared into a synthetic bold — which is exactly the mush this lab is trying to judge away.
     */
    weight?: number;
}

/** One thing the lab can change, with its own cookie, attribute and custom property. */
export interface Axis {
    key: string;
    label: string;
    lede: string;
    /** The attribute written on <html>. */
    attribute: string;
    /** The custom property the attribute rewrites. */
    property: string;
    /** Set alongside `property` when a face declares a weight. */
    weightProperty?: string;
    faces: Face[];
}

const TAIL = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"`;
const SERIF_TAIL = `Georgia, "Times New Roman", serif`;
const sheet = (family: string, weights: string): string => `https://fonts.googleapis.com/css2?family=${family}:wght@${weights}&display=swap`;

const READING: Axis = {
    key: "font",
    label: "Reading face",
    lede: "Body copy, labels and controls — everything that is not a headline.",
    attribute: "data-font",
    property: "--font-sans",
    faces: [
        { id: "public-sans", label: "Public Sans", stack: `"Public Sans", ${TAIL}`, note: "the chosen face: legibility first, ornament never" },
        { id: "inter", label: "Inter", stack: `"Inter", ${TAIL}`, google: sheet("Inter", "400;500;600"), note: "the neutral workhorse: tall x-height" },
        { id: "source-sans", label: "Source Sans 3", stack: `"Source Sans 3", ${TAIL}`, google: sheet("Source+Sans+3", "400;500;600"), note: "humanist and warm" },
        { id: "plex-sans", label: "IBM Plex Sans", stack: `"IBM Plex Sans", ${TAIL}`, google: sheet("IBM+Plex+Sans", "400;500;600"), note: "humanist with real character" },
        { id: "work-sans", label: "Work Sans", stack: `"Work Sans", ${TAIL}`, google: sheet("Work+Sans", "400;500;600"), note: "geometric-humanist, sturdy at 400" },
        { id: "nunito-sans", label: "Nunito Sans", stack: `"Nunito Sans", ${TAIL}`, google: sheet("Nunito+Sans", "400;500;600"), note: "soft terminals, closest to Baloo 2" },
        { id: "figtree", label: "Figtree", stack: `"Figtree", ${TAIL}`, google: sheet("Figtree", "400;500;600"), note: "friendly and modern, heavier colour" },
        { id: "rubik", label: "Rubik", stack: `"Rubik", ${TAIL}`, google: sheet("Rubik", "400;500;600"), note: "rounded corners, wide apertures" },
    ],
};

// The headline beats are set at 1.9–2.75rem and up, where a face is judged on its shapes rather than its
// legibility, so the spread is deliberate: three high-contrast serifs, three warm quiet ones, a slab, and the
// body face itself for the no-serif direction.
const DISPLAY: Axis = {
    key: "display",
    label: "Display face",
    lede: "The headline beats — “You delegate.” “Agents work.” — and every band title.",
    attribute: "data-display",
    property: "--font-display",
    weightProperty: "--display-weight",
    faces: [
        { id: "playfair", label: "Playfair Display", stack: `"Playfair Display", ${SERIF_TAIL}`, weight: 600, note: "the incumbent: high contrast, formal, tight" },
        {
            id: "fraunces",
            label: "Fraunces",
            stack: `"Fraunces", ${SERIF_TAIL}`,
            google: sheet("Fraunces", "600"),
            weight: 600,
            note: "soft old-style with a deliberate wonk — the most characterful",
        },
        {
            id: "instrument",
            label: "Instrument Serif",
            stack: `"Instrument Serif", ${SERIF_TAIL}`,
            google: sheet("Instrument+Serif", "400"),
            weight: 400,
            note: "very high contrast, editorial, of the moment",
        },
        {
            id: "dm-serif",
            label: "DM Serif Display",
            stack: `"DM Serif Display", ${SERIF_TAIL}`,
            google: sheet("DM+Serif+Display", "400"),
            weight: 400,
            note: "Playfair's shapes with more meat on them",
        },
        {
            id: "newsreader",
            label: "Newsreader",
            stack: `"Newsreader", ${SERIF_TAIL}`,
            google: sheet("Newsreader", "600"),
            weight: 600,
            note: "warm editorial serif drawn for screens",
        },
        { id: "lora", label: "Lora", stack: `"Lora", ${SERIF_TAIL}`, google: sheet("Lora", "600"), weight: 600, note: "brushed curves; calm rather than grand" },
        {
            id: "spectral",
            label: "Spectral",
            stack: `"Spectral", ${SERIF_TAIL}`,
            google: sheet("Spectral", "600"),
            weight: 600,
            note: "low contrast, screen-first, the quietest serif here",
        },
        { id: "bitter", label: "Bitter", stack: `"Bitter", ${SERIF_TAIL}`, google: sheet("Bitter", "600"), weight: 600, note: "slab serif: plain-spoken, no flourish" },
        {
            id: "display-sans",
            label: "Public Sans",
            stack: `"Public Sans", ${TAIL}`,
            weight: 600,
            note: "no serif at all — the headline in the body face, big",
        },
    ],
};

export const AXES: Axis[] = [READING, DISPLAY];

/** The face an axis wears when nothing is chosen. It is the one the site already hosts, so it needs no lab file. */
export const defaultFace = (axis: Axis): Face => axis.faces[0]!;

export const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/** Every face the generator has to fetch, across both axes. */
export const fetchable = (): Face[] => AXES.flatMap((axis) => axis.faces).filter((face) => face.google !== undefined);

/** The `data-*` rules, built from the catalogues so the lists above are the only place a face is named. */
export const typefaceCss = (): string =>
    AXES.flatMap((axis) =>
        axis.faces
            .filter((face) => face.id !== defaultFace(axis).id)
            .map((face) => {
                const weight = axis.weightProperty !== undefined && face.weight !== undefined ? `${axis.weightProperty}:${face.weight};` : "";
                return `html[${axis.attribute}="${face.id}"]{${axis.property}:${face.stack};${weight}}`;
            }),
    ).join("");

/**
 * Applies both chosen faces before first paint. Same shape as the variant script in variant.ts, and for the same
 * reason: a second round trip would show the page in the old face first. It only sets attributes — every face is
 * declared in the stylesheet already, and a face nobody is wearing is never downloaded, so there is nothing to fetch.
 */
export const typefaceScript = (): string => {
    const axes = AXES.map((axis) => ({ param: axis.key, cookie: axis.key, attribute: axis.attribute, fallback: defaultFace(axis).id }));
    return `(function () {
    var axes = ${JSON.stringify(axes)};
    var url = new URL(window.location.href);
    var touched = false;
    for (var i = 0; i < axes.length; i += 1) {
        var axis = axes[i];
        var asked = url.searchParams.get(axis.param);
        var chosen;
        if (asked !== null) {
            chosen = asked;
            document.cookie = axis.cookie + "=" + encodeURIComponent(chosen) +
                ";path=/;max-age=${COOKIE_MAX_AGE};samesite=lax";
            url.searchParams.delete(axis.param);
            touched = true;
        } else {
            var jar = new RegExp("(?:^|; )" + axis.cookie + "=([^;]*)").exec(document.cookie);
            chosen = jar === null ? "" : decodeURIComponent(jar[1]);
        }
        if (chosen !== "" && chosen !== axis.fallback) {
            document.documentElement.setAttribute(axis.attribute, chosen);
        }
    }
    if (touched) {
        window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
})();`;
};

/** What the switcher marks as worn, which only the browser knows — the HTML is one cached document for every choice. */
export const typefaceMarkScript = (): string => {
    const axes = AXES.map((axis) => ({ attribute: axis.attribute, fallback: defaultFace(axis).id }));
    return `(function () {
    var axes = ${JSON.stringify(axes)};
    for (var i = 0; i < axes.length; i += 1) {
        var worn = document.documentElement.getAttribute(axes[i].attribute) ?? axes[i].fallback;
        var choice = document.querySelector('[data-face="' + axes[i].attribute + ':' + worn + '"]');
        if (choice !== null) {
            choice.setAttribute("aria-current", "true");
        }
    }
})();`;
};
