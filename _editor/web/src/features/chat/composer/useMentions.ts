// The composer's `@` token: detects the one at the caret, reads a `kind:` drill prefix off it, and rewrites it once
// something is picked. A picked file becomes `@path ` (the wire form the daemon and the fold read); a picked setting
// leaves no text, since its home is the pill row.

export interface MentionQuery {
    // Index of the `@` in the draft.
    readonly start: number;
    // The token typed after the `@` so far (may be empty right after typing `@`).
    readonly query: string;
}

// The active @-token ending at the caret: an `@` preceded by start-of-text or whitespace, with no whitespace
// before the caret; undefined otherwise.
export const mentionQueryAt = (text: string, caret: number): MentionQuery | undefined => {
    const upto = text.slice(0, caret);
    const start = upto.lastIndexOf(`@`);
    if (start === -1) {
        return undefined;
    }
    if (start > 0 && !/\s/.test(upto[start - 1] as string)) {
        return undefined;
    }
    const query = upto.slice(start + 1);
    if (/\s/.test(query)) {
        return undefined;
    }
    return { start, query };
};

// The four settings the token can drill into; each is the keyword typed before the colon (`@model:son`).
export const QUICK_KINDS = [`persona`, `sandbox`, `model`, `effort`] as const;
export type QuickKind = (typeof QUICK_KINDS)[number];

export interface MentionToken {
    // Set when the token opens with `<kind>:`; the picker then lists that kind alone.
    readonly kind: QuickKind | undefined;
    // What is searched: the token, or what follows the colon.
    readonly query: string;
}

// Reads the drill prefix off a token. Exact keyword plus colon only: `personas` is a search, `persona:` is a drill.
export const parseMentionToken = (token: string): MentionToken => {
    const colon = token.indexOf(`:`);
    if (colon === -1) {
        return { kind: undefined, query: token };
    }
    const kind = QUICK_KINDS.find((candidate) => candidate === token.slice(0, colon));
    return kind === undefined ? { kind: undefined, query: token } : { kind, query: token.slice(colon + 1) };
};

// Replace the active token (the `@` included) with `replacement`; an empty replacement also drops the space that
// would be left doubled or leading, so `fix @int| please` becomes `fix please` rather than `fix  please`.
export const replaceMention = (text: string, mention: MentionQuery, caret: number, replacement: string): { text: string; caret: number } => {
    const before = text.slice(0, mention.start);
    let after = text.slice(caret);
    if (replacement === `` && /(?:^|\s)$/.test(before) && /^\s/.test(after)) {
        after = after.slice(1);
    }
    return { text: `${before}${replacement}${after}`, caret: mention.start + replacement.length };
};

// The wire form of a mentioned file, with the trailing space that ends the token.
export const fileMention = (path: string): string => `@${path} `;

// The token a summary row drills into: `@model:`, no trailing space, so the caret stays inside the token.
export const drillMention = (kind: QuickKind): string => `@${kind}:`;
