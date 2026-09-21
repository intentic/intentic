// Two readers of the same @-mention text: the composer resolves a path into a Read-tool attachment, the fold draws
// uploaded files as chips and hides inline mentions since they're already visible in the words. One tokenizer keeps
// them in agreement.

// Broad on purpose, including invalid mentions: old turns persisted these candidates in the attachment field, and the
// fold needs the same broad set to hide them.
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

// Excludes a copied pnpm script prefix (`@scope/package:test:`), which shares the opening shape but is not a file;
// accepting it creates a phantom attachment.
const PACKAGE_SCRIPT = /^[^/]+\/[^/]+:[^/]+$/u;
// A mention names a workspace-relative path and nothing else: the picker inserts one from the workspace index, an
// upload mints one under the state dir. An absolute, home, drive-letter or climbing token is therefore never a
// mention, and curl's `@file` argument (`--data-binary @/tmp/req.json`) wears exactly that shape in pasted output.
const OUTSIDE_WORKSPACE = /^(?:[/~]|[A-Za-z]:[\\/]|\.\.(?:[/\\]|$))/u;
// How many a turn may carry; the tokenizer stops here rather than letting a pasted log's 21st token refuse the turn.
export const MENTION_LIMIT = 20;
export const mentionPaths = (text: string): string[] =>
    mentionedPathTokens(text)
        .filter((token) => !PACKAGE_SCRIPT.test(token) && !OUTSIDE_WORKSPACE.test(token))
        .slice(0, MENTION_LIMIT);
