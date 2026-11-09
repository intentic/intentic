// How a setting of the Overview's list is drawn, the look the secrets and automations lists already wear: a value that is
// also the place to change it has no box at rest and a hover wash under the pointer, so the list reads as text and
// still answers the hand. Pulled out by its own padding, so its words line up with the rows around it, not the wash.
export const EDITABLE_VALUE = `group/value -mx-2 flex min-w-0 cursor-pointer flex-col items-start rounded-md px-2 py-1 text-left transition-colors hover:bg-content/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`;

// The same value where nothing here can change it: the same box, so a column of mixed rows keeps one edge.
export const FIXED_VALUE = `flex min-w-0 flex-col items-start py-1`;

// The heading's fact chips (the image, the version): a mono chip, its parts coloured by the caller. Its geometry and its
// quiet colours are apart, so a chip that reports something (an update) can wear a tone's wash instead of the quiet one.
export const FACT_CHIP = `inline-flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-2xs leading-4`;
export const FACT_CHIP_QUIET = `border-line-subtle bg-content/5 text-muted`;

// A container image reference in the parts a reader tells apart at a glance: where it comes from (registry and path,
// dimmed), its name, and the tag or digest that pins it (in the accent). Nothing is dropped: the parts join back to
// the reference exactly.
export interface ImageRefParts {
    source: string;
    name: string;
    separator: string;
    ref: string;
}

export const splitImageRef = (image: string): ImageRefParts => {
    const slash = image.lastIndexOf(`/`);
    const source = image.slice(0, slash + 1);
    const rest = image.slice(slash + 1);
    const at = rest.indexOf(`@`);
    const colon = rest.indexOf(`:`);
    const cut = at !== -1 ? at : colon;
    if (cut === -1) {
        return { source, name: rest, separator: ``, ref: `` };
    }
    return { source, name: rest.slice(0, cut), separator: rest[cut]!, ref: rest.slice(cut + 1) };
};

// A version as a reader expects to see one: `v` before a bare number, anything else as it is.
export const versionLabel = (version: string): string => (/^\d/.test(version) ? `v${version}` : version);
