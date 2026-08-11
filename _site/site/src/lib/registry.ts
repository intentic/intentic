import {
    compareEntries,
    OFFICIAL_REGISTRY_URL,
    REGISTRY_FACTS_FILE,
    REGISTRY_FILE,
    type RegistryEntry,
    RegistryFactsSchema,
    RegistryFileSchema,
    resolveRegistry,
} from "@intentic/registry";
import fallback from "./registry.fallback.json";

/* The gallery's data, read at BUILD time from the registry repository — so `/extensions/` is a static page
 * cut from a JSON file, exactly like `/product/` and `/compare/`, with no backend, no database and no admin
 * panel behind it. Curation happens as pull requests over there; a deploy is how it reaches the web.
 *
 * The build fetches raw from GitHub and falls back to the vendored copy imported above when that fails. A
 * site deploy must not be hostage to GitHub being up, and a gallery a fortnight stale is a far better outcome
 * than a red pipeline on an unrelated change. It is an import rather than a read so it rides into the bundle
 * and works wherever the prerender runs from. Refresh it with `pnpm -C _site/site sync:registry`. */

const RAW_BASE = `${OFFICIAL_REGISTRY_URL.replace("https://github.com/", "https://raw.githubusercontent.com/")}/HEAD`;

export interface Gallery {
    entries: RegistryEntry[];
    /** When the scanner last read the source hosts — the page dates its star counts rather than implying they're live. */
    scannedAt: string | undefined;
    /** True when the vendored copy was used, so a preview build can say so instead of looking current. */
    stale: boolean;
}

const fromFiles = (rawFile: string, rawFacts: string | undefined): Omit<Gallery, "stale"> => {
    const file = RegistryFileSchema.parse(JSON.parse(rawFile));
    const facts = rawFacts === undefined ? undefined : RegistryFactsSchema.parse(JSON.parse(rawFacts));
    return {
        // Blocked rows exist so an installed sandbox can be warned; a shop window is not where that belongs.
        entries: resolveRegistry(file, facts, OFFICIAL_REGISTRY_URL)
            .filter((entry) => entry.kind === "extension" && entry.trust !== "blocked" && entry.admitted)
            .toSorted(compareEntries),
        scannedAt: facts?.scannedAt,
    };
};

const fetchText = async (path: string): Promise<string | undefined> => {
    const response = await fetch(`${RAW_BASE}/${path}`);
    if (response.status === 404) {
        return undefined;
    }
    if (!response.ok) {
        throw new Error(`registry ${response.status} fetching ${path}`);
    }
    return response.text();
};

export const loadGallery = async (): Promise<Gallery> => {
    try {
        const rawFile = await fetchText(REGISTRY_FILE);
        if (rawFile === undefined) {
            throw new Error(`no ${REGISTRY_FILE} at ${RAW_BASE}`);
        }
        return { ...fromFiles(rawFile, await fetchText(REGISTRY_FACTS_FILE)), stale: false };
    } catch (error) {
        console.warn(`[registry] live read failed (${String(error)}) — building the gallery from the vendored copy`);
        return { ...fromFiles(JSON.stringify(fallback.file), JSON.stringify(fallback.facts)), stale: true };
    }
};

// github.com/owner/repo for the card's "source" link — the resolved pointer minus git's .git suffix.
export const sourceHref = (entry: RegistryEntry): string | undefined => entry.install?.url.replace(/\.git$/, "");

/* THE CARD'S MARK, and what this page can and cannot draw of it.
 *
 * A registry row carries the two tiers the manifest declares — a simple-icons `logo` and an `icon` from the
 * app's own set — and this page can honour only the first. The second is a name in a vocabulary that exists as
 * bundled Iconify data inside @intentic/ui, a Vue design system; a static marketing page has no dependency on
 * it and should not grow one to draw ~90 glyphs it would then ship to every visitor. So the glyph tier
 * DEGRADES here to the tier below it, and every card without a logo wears its initials.
 *
 * The initials rule is deliberately the same as `initialsOf` in @intentic/ui and deliberately a second copy of
 * it: there is no dependency edge from this site to that package, and one shouldn't be added for eight lines
 * of string handling. Keep them in step by hand — "acme.jira" → AJ on both sides. */
export const markInitials = (name: string): string => {
    const words = name.split(/[\s._@-]+/).filter((word) => word !== "");
    const [first, second] = words;
    if (first === undefined) {
        return "";
    }
    return (second === undefined ? first.slice(0, 2) : `${first[0]}${second[0]}`).toUpperCase();
};

// The simple-icons CDN URL a row's logo slug resolves to, or undefined for a row that declared none.
export const markLogoUrl = (entry: RegistryEntry): string | undefined =>
    entry.logo === undefined ? undefined : `https://cdn.simpleicons.org/${entry.logo}`;
