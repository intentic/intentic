/* What a note looks like in the browser: the wiki links in its prose turned into things you can click, and the
 * small vocabulary of colour and icon the list and the pane share. Pure apart from the DOM the decorator is
 * handed, unit-tested in knowledgeNote.test.ts. */

import type { IconName } from "@intentic/extension-ui";

// `[[target]]` / `[[target|what to call it]]`. The same syntax the knowledge base engine reads, and the same one the
// memory notes already use between themselves.
const WIKI_LINK = /\[\[([^\][|]+)(?:\|([^\]]+))?\]\]/g;

/* Turn every `[[link]]` in the rendered prose into an anchor the view can act on.
 *
 * RESOLUTION IS NOT REDONE HERE. The backend already resolved every link this note holds, by path, filename,
 * title and alias, and handed the answers over with the note. A second resolver in the browser would be a
 * second set of rules to disagree with the first, and it would have only the note's own text to work from,
 * which is not enough to know that `[[Ada]]` is an alias of someone. So the caller passes the lookup it was
 * given, and a target that isn't in it is a note nobody has written, drawn as such rather than as a link that
 * goes nowhere when clicked.
 *
 * Anchors carry `data-kb` rather than an href, because the destination is a selection inside this view and not
 * a URL a browser could visit; one delegated listener on the prose turns a click into a selection. This runs on
 * the sanitized fragment (the markdown pipeline's contract) and only ever authors its own markup, anchor text
 * is written as a text node, never as HTML. */
export const linkifyNoteRefs = (fragment: DocumentFragment, resolve: (target: string) => string | undefined): void => {
    // Collected before rewriting: replacing a text node mid-walk invalidates the walker's position. Text inside
    // a link or a code span is left alone, a wiki link there is either already a link or deliberately literal,
    // which is how the vocabulary note documents the syntax without every example becoming a link.
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
    const pending: Text[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node as Text;
        if (text.parentElement?.closest(`a, code, pre`) != null) {
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
            const target = (match[1] ?? ``).trim();
            const path = resolve(target);
            const anchor = document.createElement(`a`);
            anchor.append(match[2]?.trim() ?? target);
            if (path === undefined) {
                // A link to a note nobody has written yet is ordinary and deliberate, the knowledge base's own to-do
                // list. It reads as unfinished rather than as broken, and it is not clickable, because there is
                // nothing on the other side of it.
                anchor.className = `text-subtle underline decoration-dotted underline-offset-2`;
                anchor.title = `No note for "${target}" yet`;
            } else {
                anchor.dataset[`kb`] = path;
                anchor.className = `md-file-link`;
            }
            replacement.append(anchor);
            cursor = match.index + match[0].length;
        }
        replacement.append(text.data.slice(cursor));
        text.replaceWith(replacement);
    }
};

/* ONE COLOUR PER KIND, decided from the word itself rather than from a table.
 *
 * A table would have to be written for a vocabulary that belongs to the knowledge base, not to this app, every owner
 * has different kinds, and an unlisted one would fall to grey while its neighbours were coloured, which reads
 * as "this one is somehow lesser". Hashing the word means every kind gets a colour, the same colour every time,
 * for free; what the colour MEANS is only ever "same as that other one", which is the whole job here. */
const TONES = [`primary`, `info`, `success`, `warning`, `danger`, `neutral`] as const;
export type Tone = (typeof TONES)[number];

export const toneOfType = (type: string | undefined): Tone => {
    if (type === undefined || type === ``) {
        return `neutral`;
    }
    let hash = 0;
    for (const char of type) {
        hash = (hash * 31 + char.codePointAt(0)!) % 100_003;
    }
    return TONES[hash % TONES.length]!;
};

/* THE SAME COLOUR AS THE PANE'S BADGE, WORN AS A DOT, for the index column.
 *
 * A pill is the right shape for the kind beside a note's title in the PANE, where the width is there to read a
 * word in. In a 14rem index it is not: measured, the badge and the trailing date between them left a note's
 * NAME 65px of a 256px row, so two thirds of the list truncated to one word and the thing you pick by was the
 * smallest thing on the row. The kind's job in a LIST is recognition, not reading — "same as that one" — and a
 * 6px dot does that at a twentieth of the width. The word itself has not gone anywhere: it rides the row's
 * quiet second line, where the space is free.
 *
 * Derived from `toneOfType` rather than from a palette of its own, so the dot and the badge one click apart can
 * never disagree about what `decision` looks like. */
const TONE_DOTS: Record<Tone, string> = {
    primary: `bg-primary-500`,
    info: `bg-info`,
    success: `bg-success`,
    warning: `bg-warning`,
    danger: `bg-danger`,
    neutral: `bg-subtle`,
};

export const dotOfType = (type: string | undefined): string => TONE_DOTS[toneOfType(type)];

/* ONE ICON PER STARTER KIND, and `file` for everything else.
 *
 * Icons carry meaning a coloured dot cannot: `person` and `project` are different shapes before you read a
 * word. The starter vocabulary's kinds each get one; an owner's custom kinds fall back to the same note glyph
 * the pane uses, rather than guessing at a silhouette nobody agreed on. Matching is case-insensitive because
 * the vocabulary note lists lowercase kinds and frontmatter sometimes does not. */
const TYPE_ICONS: Record<string, IconName> = {
    person: `user`,
    project: `folder`,
    company: `globe`,
    decision: `check-square`,
    meeting: `users`,
    term: `book`,
    source: `link`,
    vocabulary: `sitemap`,
};

export const iconOfType = (type: string | undefined): IconName => {
    if (type === undefined || type === ``) {
        return `file`;
    }
    return TYPE_ICONS[type.toLowerCase()] ?? `file`;
};
