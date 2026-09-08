// @-file mentions in the chat composer: detects the active `@token` at the caret, inserts a picked path, and
// extracts mentioned workspace paths on send. Mentioned paths ride the turn's `attachments` wire field, no upload.

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

// Replace the active mention token with the picked path (plus a trailing space).
export const insertMention = (text: string, mention: MentionQuery, caret: number, path: string): { text: string; caret: number } => {
    const next = `${text.slice(0, mention.start)}@${path} ${text.slice(caret)}`;
    return { text: next, caret: mention.start + path.length + 2 };
};
