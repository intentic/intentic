// Backticks in a guide's prose mark literals (scope, menu item, host, command, port); everything else is prose.
// Authored, not detected: a pattern-matcher can't reliably tell a GitHub scope from an English word, but whoever
// wrote the sentence already knows.
export interface GuidePart {
    readonly text: string;
    readonly literal: boolean;
}

// Capturing split alternates prose/capture, so odd indices are the backticked runs; an unpaired backtick stays in
// the prose.
export const guideParts = (line: string): readonly GuidePart[] => {
    const raw = line
        .split(/`([^`]+)`/g)
        .map((text, index) => ({ text, literal: index % 2 === 1 }))
        .filter((part) => part.text !== ``);

    // Trailing whitespace on an inline span is dropped before the next span; carry each gap onto the next part's
    // leading edge instead.
    return raw.map((part, index) => {
        if (index === 0) {
            return { ...part, text: part.text.trimEnd() };
        }
        const prev = raw[index - 1]!;
        const needsSpace = prev.text.endsWith(` `) || part.text.startsWith(` `);
        let text = part.text;
        if (needsSpace) {
            text = text.trimStart();
            if (!text.startsWith(` `)) {
                text = ` ${text}`;
            }
        }
        return { ...part, text: text.trimEnd() };
    });
};

// Scopes lines lead with a translated prefix; its trailing space must live on the first catalog part, not after it.
export const guidePartsPrefixed = (prefix: string, line: string): readonly GuidePart[] => {
    const parts = guideParts(line);
    if (parts.length === 0) {
        return [{ text: prefix, literal: false }];
    }
    const [first, ...rest] = parts;
    return [{ text: prefix, literal: false }, { text: ` ${first.text}`, literal: first.literal }, ...rest];
};
