import type { Unzipped } from "fflate";
import { attr, parseXml } from "./xml-dom";

/* A .pptx as what it is: a zip of XML parts that point at each other through per-part relationship files. Every
   cross-part link in a deck (slide → layout → master → theme, picture → image bytes) is an `r:id` resolved here. */

export interface Relationship {
    readonly type: string;
    /** Resolved to a package path, so callers never do path arithmetic on a `../media/image1.png`. */
    readonly target: string;
    /** External targets (a linked image, a hyperlink) have no bytes in the package; nothing here can render one. */
    readonly external: boolean;
}

export interface Package {
    /** Every part in the package, which is what answers "which slides are in here" when the deck's own index is broken. */
    readonly names: readonly string[];
    readonly bytes: (path: string) => Uint8Array | undefined;
    /** A part as a parsed root element; a missing or unparseable part is `undefined`, since every caller can go on without one. */
    readonly xml: (path: string) => Element | undefined;
    /** That part's relationships by id. Parts with no `_rels` file answer with an empty map. */
    readonly rels: (path: string) => ReadonlyMap<string, Relationship>;
}

// "../media/image1.png" against "ppt/slides/slide1.xml" is "ppt/media/image1.png"; a leading "/" is package-absolute.
const resolvePath = (from: string, target: string): string => {
    if (target.startsWith("/")) {
        return target.slice(1);
    }
    const stack = from.split("/").slice(0, -1);
    for (const piece of target.split("/")) {
        if (piece === "..") {
            stack.pop();
        } else if (piece !== "." && piece !== "") {
            stack.push(piece);
        }
    }
    return stack.join("/");
};

const relsPathOf = (path: string): string => {
    const cut = path.lastIndexOf("/");
    return `${path.slice(0, cut + 1)}_rels/${path.slice(cut + 1)}.rels`;
};

// `files` is the package already inflated (zip/unzip.ts), so opening it is parsing only.
export const openPackage = (files: Unzipped): Package => {
    const decoder = new TextDecoder();
    const parsed = new Map<string, Element | undefined>();
    const related = new Map<string, ReadonlyMap<string, Relationship>>();

    const bytes = (path: string): Uint8Array | undefined => files[path];

    const xml = (path: string): Element | undefined => {
        if (parsed.has(path)) {
            return parsed.get(path);
        }
        const raw = files[path];
        let root: Element | undefined;
        try {
            root = raw === undefined ? undefined : parseXml(decoder.decode(raw));
        } catch {
            // A corrupt part is one missing slide, not a dead viewer: the rest of the deck still renders.
            root = undefined;
        }
        parsed.set(path, root);
        return root;
    };

    const rels = (path: string): ReadonlyMap<string, Relationship> => {
        const known = related.get(path);
        if (known !== undefined) {
            return known;
        }
        const relsPath = relsPathOf(path);
        const map = new Map<string, Relationship>();
        for (const node of xml(relsPath)?.children ?? []) {
            const id = attr(node, "Id");
            const target = attr(node, "Target");
            if (id === undefined || target === undefined) {
                continue;
            }
            const external = attr(node, "TargetMode") === "External";
            map.set(id, { type: attr(node, "Type") ?? "", target: external ? target : resolvePath(path, target), external });
        }
        related.set(path, map);
        return map;
    };

    return { names: Object.keys(files), bytes, xml, rels };
};

/** The part this relationship id points at, or `undefined` when the link is broken or leaves the package. */
export const relatedPart = (pack: Package, from: string, id: string | undefined): string | undefined => {
    if (id === undefined) {
        return undefined;
    }
    const rel = pack.rels(from).get(id);
    return rel === undefined || rel.external ? undefined : rel.target;
};

/** The one part of this relationship kind, by the last segment of its type URI (`slideLayout`, `notesSlide`, `theme`). */
export const relatedOfType = (pack: Package, from: string, kind: string): string | undefined => {
    for (const rel of pack.rels(from).values()) {
        if (!rel.external && rel.type.endsWith(`/${kind}`)) {
            return rel.target;
        }
    }
    return undefined;
};
