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
export const mentionPaths = (text: string): string[] => mentionedPathTokens(text).filter((token) => !PACKAGE_SCRIPT.test(token));
