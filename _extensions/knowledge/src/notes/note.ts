import { parseFrontmatter } from "./frontmatter.js";
import { wikiLinksIn } from "./wiki-links.js";

// Pure: text in, facts out, shared by the backend, the CLI, and tests; no filesystem here (see read-notes.ts). Markdown
// already carries a typed graph: `type:` names the note's kind, a link in a header field is a typed edge, a link in
// prose is untyped.

// Header keys describing the note itself, not connecting it; a link in any other field is a relation.
const RESERVED = new Set(["type", "title", "aliases", "tags", "created", "updated", "types", "relations"]);

// An inline `#tag`: preceded by line-start or whitespace, so a word/URL fragment or a `# heading` isn't one.
const INLINE_TAG = /(?:^|\s)#([a-z0-9][\w/-]*)/giu;

export interface NoteLink {
    // The link as written, before resolution; resolving needs the whole knowledge base.
    readonly target: string;
    readonly label: string | undefined;
    // The header field that carried it, undefined for a prose link; this is what types the edge.
    readonly relation: string | undefined;
}

export interface ParsedNote {
    // Relative to the knowledge folder, forward-slash, with extension; the note's identity.
    readonly path: string;
    // Filename without extension: what `[[ada-lovelace]]` matches, and what a new note is named from.
    readonly slug: string;
    readonly title: string;
    readonly type: string | undefined;
    readonly aliases: readonly string[];
    readonly tags: readonly string[];
    // Every header field that parsed, normalised to lists; the note's facts, links included.
    readonly fields: ReadonlyMap<string, readonly string[]>;
    // Header keys this build couldn't read (nested map, multi-line scalar); reported, never thrown.
    readonly unreadable: readonly string[];
    readonly links: readonly NoteLink[];
    // The note without its header; what gets rendered and what a body search reads.
    readonly body: string;
    // Carried, not re-read: an editor round-trips these bytes, so a save can't clobber a concurrent edit.
    readonly content: string;
    readonly modifiedAt: number;
    readonly sizeBytes: number;
}

// Raw file as the reader hands it over; the input to everything in this directory.
export interface NoteFile {
    readonly path: string;
    readonly content: string;
    readonly modifiedAt: number;
    readonly sizeBytes: number;
}

const slugOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");

// Display title in the order a reader wants: the note's own title, then its first heading, then its filename made
// legible. Only the first letter is cased; these are names and sentences, not headings.
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

// Prose with fenced and inline code removed, so an example `[[link]]` or `#tag` isn't read as a real one.
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

// Header fields connecting this note to another, in file order: the note's outgoing typed edges.
export const relationsOf = (note: ParsedNote): readonly string[] => [
    ...new Set(note.links.flatMap((link) => (link.relation === undefined ? [] : [link.relation]))),
];

// Header fields that are plain facts: not reserved, and not holding a link.
export const factsOf = (note: ParsedNote): readonly (readonly [string, readonly string[]])[] =>
    [...note.fields].filter(([key, values]) => !RESERVED.has(key) && !values.some((value) => value.includes("[[")));
