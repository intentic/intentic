// Wiki links in a note's rendered prose turned into clickable anchors, plus the colour/icon vocabulary the list and
// pane share. Pure apart from the DOM fragment it's handed; unit-tested in knowledgeNote.test.ts.

import type { IconName } from "@intentic/extension-ui";

// `[[target]]` or `[[target|label]]`; the same syntax the engine and memory notes use.
const WIKI_LINK = /\[\[([^\][|]+)(?:\|([^\]]+))?\]\]/g;

// Resolution isn't redone here: the caller supplies the lookup the backend already resolved. A missing target means an
// unwritten note, drawn as such; anchors carry `data-kb`, not an href, a selection, not a URL.
export const linkifyNoteRefs = (fragment: DocumentFragment, resolve: (target: string) => string | undefined): void => {
    // Collected before rewriting: replacing a node mid-walk breaks the walker; skips text in a link or code span.
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
                // An unwritten note's link is deliberate, the kb's own to-do; shown unfinished, not clickable.
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

// One colour per kind, hashed from the word since kinds are open-ended and owner-defined, not from a table.
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

// Same colour as the badge, as a dot: the index row is too narrow for a pill; recognition, not reading.
const TONE_DOTS: Record<Tone, string> = {
    primary: `bg-primary-500`,
    info: `bg-info`,
    success: `bg-success`,
    warning: `bg-warning`,
    danger: `bg-danger`,
    neutral: `bg-subtle`,
};

export const dotOfType = (type: string | undefined): string => TONE_DOTS[toneOfType(type)];

// One icon per starter kind, `file` otherwise; matched case-insensitively (frontmatter isn't always lowercase).
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
