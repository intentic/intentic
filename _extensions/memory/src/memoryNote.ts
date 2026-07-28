/* What a memory note is, as far as the browser is concerned: a title, a frontmatter header, a body, and links
 * to its siblings. Everything here is derived from a file NAME or its raw text, so the list can be titled and
 * grouped without opening a single note. Pure (no Vue, no DOM at call time) — unit-tested in memoryNote.test.ts. */

// The index the agent loads at the start of every session. It links to every other note in its project, so it
// is pinned above them and read as navigation rather than as a fact of its own.
export const INDEX_NAME = `MEMORY.md`;

export interface ParsedNote {
    // The agent's own one-line summary of the note, from frontmatter — the subtitle the reader wants first.
    readonly description: string | undefined;
    // What KIND of memory this is (project, user, reference…), shown as the note's one chip.
    readonly type: string | undefined;
    // The note without its frontmatter. The raw file is what an edit round-trips; this is what gets rendered.
    readonly body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/* Frontmatter is read with two regexes rather than a YAML parser: the fields displayed are scalars, the notes
 * are written by the agent to a fixed template, and a malformed header must degrade to "no chip, no subtitle"
 * instead of throwing inside a render. `type` is matched unanchored to the left because the agent nests it
 * under `metadata:` — and `^\s*type:` cannot collide with `node_type:`, which has no line break before it. */
export const parseNote = (content: string): ParsedNote => {
    const match = FRONTMATTER.exec(content);
    if (match === null) {
        return { description: undefined, type: undefined, body: content };
    }
    const field = (name: string): string | undefined => {
        const value = new RegExp(`^\\s*${name}:\\s*(.+)$`, `m`).exec(match[1] ?? ``)?.[1]?.trim();
        return value === undefined || value === `` ? undefined : value.replace(/^"(.*)"$/, `$1`);
    };
    return { description: field(`description`), type: field(`type`), body: content.slice(match[0].length) };
};

/* A note's display title. The agent names its files as slugs ("intentic-rtk-backend.md") and repeats the same
 * string in frontmatter, so the filename alone is enough — no note has to be fetched for the list to read as
 * prose. Only the first letter is cased: these are sentences, not headlines, and force-capitalising every word
 * turns "iq failure analysis" into a product name. */
export const noteTitle = (name: string): string => {
    const base = name.slice(name.lastIndexOf(`/`) + 1).replace(/\.md$/i, ``);
    const words = base.replace(/[-_]+/g, ` `).trim();
    return words === `` ? name : words.charAt(0).toUpperCase() + words.slice(1);
};

/* A project directory is named after the agent's working directory with every "/" replaced by "-", so it reads
 * back the same way: "-history-gits-root" is /history/gits/root. The slug is lossy — a directory whose own name
 * contains a dash is indistinguishable from a separator — and the case that actually bites is worktrees, whose
 * UUID becomes five bogus path segments. That one shape is put back together; anything else is left as split,
 * which is still far more legible than the raw slug. A project name that isn't a path is returned untouched. */
const UUID_SEGMENTS = /\/([0-9a-f]{8})\/([0-9a-f]{4})\/([0-9a-f]{4})\/([0-9a-f]{4})\/([0-9a-f]{12})(?=\/|$)/gi;

export const projectLabel = (project: string): string =>
    project.startsWith(`-`) ? project.replace(/-/g, `/`).replace(UUID_SEGMENTS, `/$1-$2-$3-$4-$5`) : project;

/* Where a link inside a note points, as a note name in the same project, or undefined if it leads anywhere
 * else. MEMORY.md's entries are relative ("intentic-rtk-backend.md") and a note may sit in a subdirectory, so
 * an href resolves against the LINKING note's own directory — markdown's rule, and the one the agent writes to.
 * Anything with a scheme, a protocol-relative host, or a non-markdown target is somebody else's link. */
export const resolveNoteLink = (from: string, href: string): string | undefined => {
    const target = href.split(/[#?]/)[0] ?? ``;
    if (target === `` || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith(`//`)) {
        return undefined;
    }
    // An absolute href is read as project-relative: a note has no filesystem above its own memory directory.
    const segments = target.startsWith(`/`) ? [] : from.split(`/`).slice(0, -1);
    for (const part of target.split(`/`)) {
        if (part === `` || part === `.`) {
            continue;
        }
        if (part === `..`) {
            segments.pop();
            continue;
        }
        segments.push(part);
    }
    const name = segments.join(`/`);
    return name.toLowerCase().endsWith(`.md`) ? name : undefined;
};

/* Wiki links — `[[intentic-rtk-backend]]`, optionally `[[target|label]]`. The agent cross-references its own
 * notes in this syntax, which markdown has no idea about, so without this they render as literal brackets in
 * the middle of a sentence. Exported as a matcher rather than a rewrite because the substitution happens on the
 * sanitized DOM (see linkifyNoteRefs), where it cannot corrupt markup or touch a code block. */
const WIKI_LINK = /\[\[([^\][|]+)(?:\|([^\]]+))?\]\]/g;

// One wiki link's destination and text: `[[a-note]]` reads as its title, `[[a-note|see here]]` as written.
export const wikiLinkParts = (target: string, label: string | undefined): { name: string; text: string } => {
    const trimmed = target.trim();
    const name = trimmed.toLowerCase().endsWith(`.md`) ? trimmed : `${trimmed}.md`;
    return { name, text: label?.trim() ?? noteTitle(trimmed) };
};

/* The decorator handed to <Markdown>: turn every reference to a sibling note into a real link, so the index
 * reads as a table of contents and a note's cross-references are one click away. Two kinds are covered — the
 * markdown links MEMORY.md is made of, and the wiki links notes use between themselves.
 *
 * Both end up as an anchor carrying `data-note`, which the view's one delegated click listener reads; they get
 * no href, because the destination is a selection inside this view rather than a URL the browser could visit.
 * This runs on the sanitized fragment (the pipeline's contract), and it only ever authors its own markup —
 * anchor text is written as a text node, never as HTML. */
export const linkifyNoteRefs = (fragment: DocumentFragment, from: string): void => {
    for (const anchor of fragment.querySelectorAll(`a`)) {
        const name = resolveNoteLink(from, anchor.getAttribute(`href`) ?? ``);
        if (name !== undefined) {
            anchor.removeAttribute(`href`);
            anchor.dataset[`note`] = name;
            anchor.classList.add(`md-file-link`);
        }
    }

    // Collected before rewriting: replacing a text node mid-walk invalidates the walker's position. Text inside
    // a link or a code span is left alone — a wiki link there is either already a link or deliberate literal.
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
    const pending: Text[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node as Text;
        const parent = text.parentElement;
        if (parent !== null && parent.closest(`a, code, pre`) !== null) {
            continue;
        }
        WIKI_LINK.lastIndex = 0;
        if (WIKI_LINK.test(text.data)) {
            pending.push(text);
        }
    }

    for (const text of pending) {
        const replacement = document.createDocumentFragment();
        let cursor = 0;
        WIKI_LINK.lastIndex = 0;
        for (let match = WIKI_LINK.exec(text.data); match !== null; match = WIKI_LINK.exec(text.data)) {
            replacement.append(text.data.slice(cursor, match.index));
            const { name, text: label } = wikiLinkParts(match[1] ?? ``, match[2]);
            const anchor = document.createElement(`a`);
            anchor.dataset[`note`] = resolveNoteLink(from, name) ?? name;
            anchor.className = `md-file-link`;
            anchor.append(label);
            replacement.append(anchor);
            cursor = match.index + match[0].length;
        }
        replacement.append(text.data.slice(cursor));
        text.replaceWith(replacement);
    }
};
