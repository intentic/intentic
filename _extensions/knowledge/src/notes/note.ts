import { parseFrontmatter } from "./frontmatter.js";
import { wikiLinksIn } from "./wiki-links.js";

/* WHAT ONE NOTE IS. Pure, text in, facts out, so the same function answers for the backend serving a panel,
 * the CLI answering the agent, and the unit tests. Nothing here touches a filesystem; see read-notes.ts.
 *
 * The whole design rests on one observation: a markdown knowledge base ALREADY carries a typed graph, and it carries it
 * in the two places the format already had. `type:` in the header says what kind of thing the note is. A link
 * inside a header FIELD says what kind of connection it is, `works_on: ["[[Intentic]]"]` is an edge labelled
 * works_on. A link in the prose is the same edge with no label. So there is no second store, no sidecar and no
 * schema migration: the ontology is what the knowledge base was already able to express, read out. */

// The header keys that describe the NOTE rather than connect it to another one. A field outside this set that
// holds a link is a relation (see `relations` below); one that holds no link is a plain fact shown beside it.
const RESERVED = new Set(["type", "title", "aliases", "tags", "created", "updated", "types", "relations"]);

// An inline `#tag` in prose: preceded by start-of-line or whitespace, so a `#` inside a word or a URL fragment
// is not one, and a markdown heading (`# Ada`) is not either, a heading has a space after the hash.
const INLINE_TAG = /(?:^|\s)#([a-z0-9][\w/-]*)/giu;

export interface NoteLink {
    // The link exactly as written, before resolution, resolving needs the whole knowledge base, which a note is not.
    readonly target: string;
    readonly label: string | undefined;
    // The header field that carried it, or undefined for a link in the prose. THIS is what makes an edge typed.
    readonly relation: string | undefined;
}

export interface ParsedNote {
    // Relative to the knowledge folder, forward-slash, with the extension: "people/ada-lovelace.md". The note's identity.
    readonly path: string;
    // The filename without its extension, what `[[ada-lovelace]]` matches, and what a new note is named from.
    readonly slug: string;
    readonly title: string;
    readonly type: string | undefined;
    readonly aliases: readonly string[];
    readonly tags: readonly string[];
    // Every header field that parsed, normalised to lists, the note's facts, links included.
    readonly fields: ReadonlyMap<string, readonly string[]>;
    // Header keys this build could not read (a nested map, a multi-line scalar). Reported, never thrown.
    readonly unreadable: readonly string[];
    readonly links: readonly NoteLink[];
    // The note without its header, what gets rendered, and what a body search reads.
    readonly body: string;
    /* The file exactly as it is on disk. Carried rather than re-read, because an editor must round-trip the
     * bytes the index was built from: fetch the note, read it back a moment later to save it, and a note
     * somebody else touched in between would be silently overwritten with a stale copy of itself. */
    readonly content: string;
    readonly modifiedAt: number;
    readonly sizeBytes: number;
}

// A raw file as the knowledge base reader hands it over, the input side of everything in this directory.
export interface NoteFile {
    readonly path: string;
    readonly content: string;
    readonly modifiedAt: number;
    readonly sizeBytes: number;
}

const slugOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");

/* A note's display title, in the order a reader would want it: what the note says it is called, then its first
 * heading, then its filename made legible. Only the first letter is cased, these are names and sentences, and
 * title-casing every word turns "iq failure analysis" into a product. The memory extension's rule, verbatim,
 * because a knowledge base and a memory note are read in the same list by the same person. */
export const titleFromSlug = (slug: string): string => {
    const words = slug.replace(/[-_]+/g, " ").trim();
    return words === "" ? slug : words.charAt(0).toUpperCase() + words.slice(1);
};

const firstHeading = (body: string): string | undefined => {
    for (const line of body.split(/\r?\n/)) {
        if (!line.startsWith("#")) {
            continue;
        }
        let textStart = 1;
        while (line[textStart] === " " || line[textStart] === "\t") {
            textStart++;
        }
        if (textStart > 1) {
            const heading = line.slice(textStart).trim();
            if (heading !== "") {
                return heading;
            }
        }
    }
    return undefined;
};

// Every link in a piece of text, tagged with the relation that carried it.
const linksIn = (text: string, relation: string | undefined): NoteLink[] => {
    const links: NoteLink[] = [];
    for (const match of wikiLinksIn(text)) {
        const target = match.target.trim();
        if (target !== "") {
            links.push({ target, label: match.label?.trim(), relation });
        }
    }
    return links;
};

// Prose with fenced and inline code removed, so a `[[link]]` or a `#tag` shown as an EXAMPLE (this knowledge base
// documents its own format in its vocabulary note) is not read as a real one.
const withoutCode = (body: string): string => body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");

export const parseNote = (file: NoteFile): ParsedNote => {
    const { fields, unreadable, body } = parseFrontmatter(file.content);
    const prose = withoutCode(body);
    const links = [
        ...[...fields].flatMap(([key, values]) => (RESERVED.has(key) ? [] : values.flatMap((value) => linksIn(value, key)))),
        ...linksIn(prose, undefined),
    ];
    const inlineTags = [...prose.matchAll(INLINE_TAG)].map((match) => (match[1] ?? "").toLowerCase());
    const slug = slugOf(file.path);
    return {
        path: file.path,
        slug,
        title: fields.get("title")?.[0] ?? firstHeading(body) ?? titleFromSlug(slug),
        type: fields.get("type")?.[0],
        aliases: fields.get("aliases") ?? [],
        tags: [...new Set([...(fields.get("tags") ?? []).map((tag) => tag.replace(/^#/, "").toLowerCase()), ...inlineTags])],
        fields,
        unreadable,
        links,
        body,
        content: file.content,
        modifiedAt: file.modifiedAt,
        sizeBytes: file.sizeBytes,
    };
};

// The header fields that connect this note to another one, in file order, the note's outgoing typed edges,
// grouped the way the panel lists them.
export const relationsOf = (note: ParsedNote): readonly string[] => [
    ...new Set(note.links.flatMap((link) => (link.relation === undefined ? [] : [link.relation]))),
];

// The header fields that are plain facts about the note, everything not reserved and not carrying a link.
export const factsOf = (note: ParsedNote): readonly (readonly [string, readonly string[]])[] =>
    [...note.fields].filter(([key, values]) => !RESERVED.has(key) && !values.some((value) => value.includes("[[")));
