/* @-FILE MENTIONS, the two readers of the same text: the composer, which sends every path a message names as
 * an attachment (the daemon resolves workspace-relative paths and folds them into the prompt as a Read-tool
 * note, no upload involved), and the fold, which draws a message's UPLOADED files as chips and its inline
 * mentions as nothing at all, because they are already visible in the words. One tokenizer, so what the
 * composer counts as a mention is what the transcript declines to redraw. */

// Every path-looking @ token in text, including tokens that are not valid composer mentions. Broad on purpose:
// old turns persisted these candidates in the shared attachment field, and the fold needs the broad set to
// recognise and hide those inline paths rather than redraw them as file chips.
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
// daemon a phantom attachment which only becomes visible when a transcript redraws the wire fields.
const PACKAGE_SCRIPT = /^[^/]+\/[^/]+:[^/]+$/u;
export const mentionPaths = (text: string): string[] => mentionedPathTokens(text).filter((token) => !PACKAGE_SCRIPT.test(token));
