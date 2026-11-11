// Two readers of the same @-mention text: the composer resolves a path into a Read-tool attachment, the fold draws
// uploaded files as chips and hides inline mentions since they're already visible in the words. One tokenizer keeps
// them in agreement.

// Broad on purpose, including invalid mentions: old turns persisted these candidates in the attachment field, and the
// fold needs the same broad set to hide them.
// A loop rather than `/[.,;:!?)]+$/`, which rescans a long run of punctuation from every one of them.
const withoutTrailingPunctuation = (token: string): string => {
    let end = token.length;
    while (end > 0 && `.,;:!?)`.includes(token.charAt(end - 1))) {
        end -= 1;
    }
    return token.slice(0, end);
};

export const mentionedPathTokens = (text: string): string[] => {
    const paths = new Set<string>();
    for (const match of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
        const token = withoutTrailingPunctuation(match[1] as string);
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
const isMention = (token: string): boolean => !PACKAGE_SCRIPT.test(token) && !OUTSIDE_WORKSPACE.test(token);
export const mentionPaths = (text: string): string[] => mentionedPathTokens(text).filter(isMention).slice(0, MENTION_LIMIT);

// Where each mention mentionPaths would send sits in the text, `@` included, so a composer can mark the very words that
// ride as files and no others. Past the limit nothing is marked, since nothing past it is sent.
export const mentionRanges = (text: string): { readonly start: number; readonly end: number; readonly path: string }[] => {
    const sent = new Set(mentionPaths(text));
    const ranges: { start: number; end: number; path: string }[] = [];
    for (const match of text.matchAll(/(^|\s)@([^\s@]+)/g)) {
        const [, lead = ``, token = ``] = match;
        const path = withoutTrailingPunctuation(token);
        if (sent.has(path)) {
            const start = match.index + lead.length;
            ranges.push({ start, end: start + 1 + path.length, path });
        }
    }
    return ranges;
};
