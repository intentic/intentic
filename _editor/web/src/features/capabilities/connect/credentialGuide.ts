// Backticks in a guide's prose mark literals (scope, menu item, host, command, port); everything else is prose.
// Authored, not detected: a pattern-matcher can't reliably tell a GitHub scope from an English word, but whoever
// wrote the sentence already knows.
export interface GuidePart {
    readonly text: string;
    readonly literal: boolean;
}

// Capturing split alternates prose/capture, so odd indices are the backticked runs; an unpaired backtick stays in
// the prose.
export const guideParts = (line: string): readonly GuidePart[] =>
    line
        .split(/`([^`]+)`/g)
        .map((text, index) => ({ text, literal: index % 2 === 1 }))
        .filter((part) => part.text !== ``);
