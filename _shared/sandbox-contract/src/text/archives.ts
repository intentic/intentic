// Which archives this sandbox can unpack, and what the folder they unpack into is called. The daemon spawns the
// tool and the browser decides whether to offer the row, so both read the answer here rather than each keeping a
// list of suffixes.

// How an archive is opened. `tar` covers the compressed tars too (the tool sniffs the compression itself); the
// single-file formats hold one compressed file and no directory structure at all.
export type ArchiveFormat = "zip" | "tar" | "gzip" | "bzip2" | "xz" | "zstd";

// Deliberately not every zip-shaped file: a .docx, .whl or .jar is a document or a package, and unpacking one in
// place is never what was meant.
const FORMATS: Readonly<Record<string, ArchiveFormat>> = {
    ".zip": "zip",
    ".tar": "tar",
    ".tar.gz": "tar",
    ".tgz": "tar",
    ".tar.bz2": "tar",
    ".tbz": "tar",
    ".tbz2": "tar",
    ".tar.xz": "tar",
    ".txz": "tar",
    ".tar.zst": "tar",
    ".tzst": "tar",
    ".gz": "gzip",
    ".bz2": "bzip2",
    ".xz": "xz",
    ".zst": "zstd",
};

// Longest first, so `.tar.gz` can never match as a lone `.gz`.
const SUFFIXES = Object.keys(FORMATS).sort((a, b) => b.length - a.length);

const matchedSuffix = (name: string): string | undefined => {
    const lower = name.toLowerCase();
    // A name that is nothing but the suffix (".zip") is a dotfile, not an archive: it would unpack into "".
    return SUFFIXES.find((suffix) => lower.endsWith(suffix) && lower.length > suffix.length);
};

/** How to unpack this file, by its name; undefined for anything this sandbox has no tool for (.7z, .rar). */
export const archiveFormat = (name: string): ArchiveFormat | undefined => {
    const suffix = matchedSuffix(name);
    return suffix === undefined ? undefined : FORMATS[suffix];
};

/** What the archive unpacks into: its name without the archive suffix. Undefined when it isn't one. */
export const archiveStem = (name: string): string | undefined => {
    const suffix = matchedSuffix(name);
    return suffix === undefined ? undefined : name.slice(0, -suffix.length);
};

// A browser's copy marker, which is how the same archive downloaded twice ends up as `site (2).zip`.
const COPY_MARKER = /\s*\(\d+\)$/;

/**
 * Whether an archive holding exactly one top-level folder is that folder rather than a folder of its own: `site.zip`
 * holding `site/` must land as one `site`, not `site/site`. Compared past a copy marker, since `site (2).zip` is the
 * same archive under a browser's name for it.
 */
export const wrapsItsOwnName = (rootName: string, stem: string): boolean =>
    rootName.toLowerCase() === stem.toLowerCase().replace(COPY_MARKER, ``);
