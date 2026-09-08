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

// Gallery data, read at build from the registry repo; a static page like `/features/`, no backend. Falls back to the
// vendored copy (registry.fallback.json) if the live fetch fails, so a deploy is never hostage to GitHub being up.
// Refresh with `pnpm -C _site/site sync:registry`.

const RAW_BASE = `${OFFICIAL_REGISTRY_URL.replace("https://github.com/", "https://raw.githubusercontent.com/")}/HEAD`;

export interface Gallery {
    entries: RegistryEntry[];
    /** When the scanner last read the source hosts: it dates the star counts rather than implying they're live. */
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
        console.warn(`[registry] live read failed (${String(error)}): building the gallery from the vendored copy`);
        return { ...fromFiles(JSON.stringify(fallback.file), JSON.stringify(fallback.facts)), stale: true };
    }
};

// github.com/owner/repo for the card's "source" link: the resolved pointer minus git's .git suffix.
export const sourceHref = (entry: RegistryEntry): string | undefined => entry.install?.url.replace(/\.git$/, "");

// Fallback mark tier: the site can draw `art`/`logo` but not the app's icon vocabulary, so an unmatched card gets
// initials. Duplicates `initialsOf` in @intentic/ui with no dependency edge; keep both in step by hand.
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

// Same validation and encoding as the app's `<BrandMark>` artSrc, kept in step by hand (no dependency edge to
// @intentic/ui). Rendered through an `<img>` so a registry-supplied SVG cannot run script.
export const markArtUrl = (entry: RegistryEntry): string | undefined => {
    const svg = entry.art?.trim();
    if (svg === undefined || !svg.startsWith("<") || !/<svg[\s>]/iu.test(svg) || !svg.endsWith("</svg>") || /<script[\s>]/iu.test(svg)) {
        return undefined;
    }
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};
