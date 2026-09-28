import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";

// Token page link: absolute for a hosted provider, or built from the instance-URL field for a self-hostable one.
// Undefined until that field holds a real http(s) URL, so no broken path-only href is shown.
export const guideTokenUrl = (entry: CapabilityCatalogEntry, values: Readonly<Record<string, string>>): string | undefined => {
    const guide = entry.guide;
    if (guide === undefined) {
        return undefined;
    }
    if (guide.urlFromField !== undefined) {
        const base = (values[guide.urlFromField] ?? ``).trim().replace(/\/+$/, ``);
        if (!/^https?:\/\//i.test(base)) {
            return undefined;
        }
        return guide.path !== undefined ? `${base}${guide.path}` : base;
    }
    return guide.url;
};

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
    // Guarded on the head itself, not on a length: a checked index is what makes the part below safe to read.
    const [first, ...rest] = guideParts(line);
    if (first === undefined) {
        return [{ text: prefix, literal: false }];
    }
    return [{ text: prefix, literal: false }, { text: ` ${first.text}`, literal: first.literal }, ...rest];
};
