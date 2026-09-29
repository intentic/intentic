import { posix } from "node:path";
import { unzipSync, type UnzipFileInfo } from "fflate";
import { error, type Finding } from "./finding.js";
import { childrenNamed, parseXml, type XmlElement } from "./xml-tree.js";

// An OOXML package (docx, pptx, xlsx) opened for checking: the zip's names, its XML parts parsed on demand, and the
// relationships that tie them together. A missing target or content type is the damage Office meets with "found a
// problem with content… repair?", so both are read off here once for every format.
// Only XML parts are inflated up front, each under a cap: a check must not be the thing a zip bomb takes down, and the
// media it needs (an image's pixel size) is inflated by name later.

const MAX_XML_PART_BYTES = 64 * 1024 * 1024;
const MAX_XML_TOTAL_BYTES = 256 * 1024 * 1024;

export interface Relationship {
    readonly id: string;
    /** The relationship type's last segment: `image`, `slide`, `hyperlink`, `slideLayout`. */
    readonly kind: string;
    /** A part name for an internal target (`ppt/media/image1.png`), the raw target for an external one. */
    readonly target: string;
    readonly external: boolean;
}

export interface OoxmlPackage {
    readonly names: ReadonlySet<string>;
    /** Parts left unread because they are over the cap, for the report's notes. */
    readonly skipped: readonly string[];
    readonly has: (part: string) => boolean;
    /** A part's parsed tree; undefined when absent or skipped. */
    readonly xml: (part: string) => XmlElement | undefined;
    /** A part's text; undefined when absent or skipped. */
    readonly text: (part: string) => string | undefined;
    /** The relationships of a part, by id (`""` for the package's own). */
    readonly rels: (part: string) => ReadonlyMap<string, Relationship>;
    /** Inflates the named binary parts (media), each under the part cap. */
    readonly binaries: (parts: readonly string[]) => Readonly<Record<string, Uint8Array>>;
}

export class NotAPackage extends Error {}

const isXmlPart = (name: string): boolean => name.endsWith(".xml") || name.endsWith(".rels") || name.endsWith(".vml");

export const openPackage = (bytes: Uint8Array): OoxmlPackage => {
    const names = new Set<string>();
    const skipped: string[] = [];
    let budget = MAX_XML_TOTAL_BYTES;
    let entries: Record<string, Uint8Array>;
    try {
        entries = unzipSync(bytes, {
            filter: (file: UnzipFileInfo) => {
                names.add(file.name);
                if (!isXmlPart(file.name)) {
                    return false;
                }
                if (file.originalSize > MAX_XML_PART_BYTES || file.originalSize > budget) {
                    skipped.push(file.name);
                    return false;
                }
                budget -= file.originalSize;
                return true;
            },
        });
    } catch (cause) {
        throw new NotAPackage(`not a readable zip package (${cause instanceof Error ? cause.message : String(cause)})`);
    }
    const decoder = new TextDecoder();
    const texts = new Map<string, string>();
    const trees = new Map<string, XmlElement>();
    const relsCache = new Map<string, ReadonlyMap<string, Relationship>>();
    const text = (part: string): string | undefined => {
        const cached = texts.get(part);
        if (cached !== undefined) {
            return cached;
        }
        const raw = entries[part];
        if (raw === undefined) {
            return undefined;
        }
        const decoded = decoder.decode(raw);
        texts.set(part, decoded);
        return decoded;
    };
    const xml = (part: string): XmlElement | undefined => {
        const cached = trees.get(part);
        if (cached !== undefined) {
            return cached;
        }
        const source = text(part);
        if (source === undefined) {
            return undefined;
        }
        const tree = parseXml(source);
        trees.set(part, tree);
        return tree;
    };
    const has = (part: string): boolean => names.has(part);
    const rels = (part: string): ReadonlyMap<string, Relationship> => {
        const cached = relsCache.get(part);
        if (cached !== undefined) {
            return cached;
        }
        const parsed = new Map<string, Relationship>();
        const tree = xml(relsPartOf(part));
        for (const relationship of tree === undefined ? [] : childrenNamed(tree, "rel:Relationship")) {
            const id = relationship.attrs["Id"];
            const rawTarget = relationship.attrs["Target"];
            if (id === undefined || rawTarget === undefined) {
                continue;
            }
            const external = relationship.attrs["TargetMode"] === "External";
            parsed.set(id, {
                id,
                kind: (relationship.attrs["Type"] ?? "").split("/").at(-1) ?? "",
                target: external ? rawTarget : resolveTarget(names, part, rawTarget),
                external,
            });
        }
        relsCache.set(part, parsed);
        return parsed;
    };
    const binaries = (parts: readonly string[]): Readonly<Record<string, Uint8Array>> => {
        const wanted = new Set(parts);
        if (wanted.size === 0) {
            return {};
        }
        return unzipSync(bytes, { filter: (file) => wanted.has(file.name) && file.originalSize <= MAX_XML_PART_BYTES });
    };
    return { names, skipped, has, xml, text, rels, binaries };
};

/** The package's main part, as its root relationships name it; `fallback` when they do not. */
export const mainPartOf = (pkg: OoxmlPackage, fallback: string): string =>
    [...pkg.rels("").values()].find((relationship) => relationship.kind === "officeDocument" && !relationship.external)?.target ?? fallback;

/** Where a part's relationships live: `ppt/slides/slide1.xml` → `ppt/slides/_rels/slide1.xml.rels`. */
export const relsPartOf = (part: string): string => (part === "" ? "_rels/.rels" : `${posix.dirname(part)}/_rels/${posix.basename(part)}.rels`.replace(/^\.\//, ""));

// A target is relative to its source part's folder, or absolute from the package root; percent-encoding is how a
// writer spells a space, and the zip may hold either spelling.
const resolveTarget = (names: ReadonlySet<string>, source: string, target: string): string => {
    const base = target.startsWith("/") ? target.slice(1) : posix.normalize(posix.join(posix.dirname(source), target)).replace(/^\.\//, "");
    if (names.has(base)) {
        return base;
    }
    try {
        return decodeURIComponent(base);
    } catch {
        return base;
    }
};

const DAMAGED = "Office will offer to repair the file, and may drop what it cannot place";

/** Internal relationships of `part` whose target is not in the package, as errors. */
export const missingTargetFindings = (pkg: OoxmlPackage, part: string, where: string, ignore: ReadonlySet<string> = new Set()): Finding[] =>
    [...pkg.rels(part).values()]
        .filter((relationship) => !relationship.external && !ignore.has(relationship.id) && !pkg.has(relationship.target))
        .map((relationship) =>
            error(
                "missing-part",
                where,
                `${relationship.kind} ${relationship.id} points to ${relationship.target}, which is not in the file: ${DAMAGED}`,
            ),
        );

// A part's extension as [Content_Types].xml keys it: `_rels/.rels` is "rels", where path.extname would say "".
const extensionOf = (name: string): string => {
    const base = posix.basename(name);
    const dot = base.lastIndexOf(".");
    return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
};

/** Package-level damage: no content type for a part, or no main part where the package root says there is one. */
export const packageFindings = (pkg: OoxmlPackage, mainPart: string): Finding[] => {
    const findings: Finding[] = [];
    const types = pkg.xml("[Content_Types].xml");
    if (types === undefined) {
        return [error("missing-part", "", `the file has no [Content_Types].xml: ${DAMAGED}`)];
    }
    if (!pkg.has(mainPart)) {
        findings.push(error("missing-part", "", `the file has no ${mainPart}, so nothing can open it as this format`));
    }
    const defaults = new Set(childrenNamed(types, "Default").map((entry) => (entry.attrs["Extension"] ?? "").toLowerCase()));
    const overrides = new Set(childrenNamed(types, "Override").map((entry) => (entry.attrs["PartName"] ?? "").replace(/^\//, "")));
    const untyped = [...pkg.names].filter(
        (name) => !name.endsWith("/") && name !== "[Content_Types].xml" && !overrides.has(name) && !defaults.has(extensionOf(name)),
    );
    if (untyped.length > 0) {
        const shown = untyped.slice(0, 3).join(", ");
        findings.push(
            error(
                "content-type",
                "",
                `no content type for ${untyped.length === 1 ? "part" : `${untyped.length} parts`} ${shown}${untyped.length > 3 ? ", …" : ""}: add a Default for the extension in [Content_Types].xml; ${DAMAGED}`,
            ),
        );
    }
    return findings;
};
