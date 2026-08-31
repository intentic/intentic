/* @-file mentions in the chat composer: pure text helpers for detecting the active `@token` at the caret,
 * inserting a picked path, and extracting mentioned workspace paths on send. Mentioned paths ride the turn's
 * existing `attachments` wire field (the daemon resolves workspace-relative paths and folds them into the
 * prompt as a Read-tool note), no upload involved, they're already workspace files. */

export interface MentionQuery {
    // Index of the `@` in the draft.
    readonly start: number;
    // The token typed after the `@` so far (may be empty right after typing `@`).
    readonly query: string;
}

// The active @-token ending at the caret: an `@` preceded by start-of-text/whitespace, with no whitespace
// between it and the caret. Undefined when the caret isn't inside one.
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

// Replace the active mention token with the picked path (plus a trailing space), returning the new draft and
// caret position.
export const insertMention = (text: string, mention: MentionQuery, caret: number, path: string): { text: string; caret: number } => {
    const next = `${text.slice(0, mention.start)}@${path} ${text.slice(caret)}`;
    return { text: next, caret: mention.start + path.length + 2 };
};

/* Every path-looking @ token in text, including tokens that are not valid composer mentions. Kept separate
 * from `mentionPaths` because old turns persisted these candidates in the shared attachment field; restore
 * needs the broad set to recognise and hide those inline paths rather than redraw them as file chips. */
export const mentionedPathTokens = (text: string): string[] => {
    const paths = new Set<string>();
    for (const match of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
        const token = (match[1] as string).replace(/[.,;:!?)]+$/, ``);
        if (token.includes(`/`) || token.includes(`.`)) {
            paths.add(token);
        }
    }
    return [...paths];
};

// Workspace paths referenced as @-mentions in a prompt, deduped. A scoped package script prefix from copied
// pnpm output has the same opening shape (`@scope/package:test:`) but is not a file; accepting it hands the
// daemon a phantom attachment which only becomes visible when a restored transcript redraws the wire fields.
const PACKAGE_SCRIPT = /^[^/]+\/[^/]+:[^/]+$/u;
export const mentionPaths = (text: string): string[] => mentionedPathTokens(text).filter((token) => !PACKAGE_SCRIPT.test(token));
