import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import { fieldApplies } from "@intentic/extension-manifest";

// The answers with the tile's fixed values laid over them, where their `when` holds: a region choice pins the cloud's
// host, which the form never shows as a box but a link is still built from.
const withPinned = (entry: CapabilityCatalogEntry, values: Readonly<Record<string, string>>) => ({
    ...values,
    ...Object.fromEntries(
        entry.fields.flatMap((field) => (field.value !== undefined && fieldApplies(field, values) ? [[field.key, field.value]] : [])),
    ),
});

// Token page link: absolute for a hosted provider, or built from the instance-URL field for a self-hostable one.
// Undefined until that field holds a real http(s) URL, so no broken path-only href is shown.
export const guideTokenUrl = (entry: CapabilityCatalogEntry, values: Readonly<Record<string, string>>): string | undefined => {
    const guide = entry.guide;
    if (guide === undefined) {
        return undefined;
    }
    if (guide.urlFromField !== undefined) {
        const base = (withPinned(entry, values)[guide.urlFromField] ?? ``).trim().replace(/\/+$/, ``);
        if (!/^https?:\/\//i.test(base)) {
            return undefined;
        }
        return guide.path !== undefined ? `${base}${guide.path}` : base;
    }
    return guide.url;
};

const FIELD_TEMPLATE = /\$\{([a-zA-Z][a-zA-Z0-9]*)(:uri)?\}/g;

// The links a connected card offers on its row (Discord's invite), filled from what the connection holds: the
// manifest's `${field}` / `${field:uri}` spelling, the same as its env. A link naming a field the connection does not
// hold is left out rather than offered half-built.
export const connectedLinks = (
    entry: CapabilityCatalogEntry,
    config: Readonly<Record<string, string | number | boolean>>,
): readonly { readonly label: string; readonly url: string }[] =>
    (entry.links ?? []).flatMap((link) => {
        const named = [...link.url.matchAll(FIELD_TEMPLATE)].map(([, key]) => String(config[key ?? ``] ?? ``));
        if (named.some((value) => value.trim() === ``)) {
            return [];
        }
        const url = link.url.replace(FIELD_TEMPLATE, (_match, key: string, uri: string | undefined) => {
            const value = String(config[key] ?? ``).trim();
            return uri === undefined ? value : encodeURIComponent(value);
        });
        return /^https?:\/\//i.test(url) ? [{ label: link.label, url }] : [];
    });

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

// A literal too long to be a menu item, a scope or a host is a command to run (SharePoint's Cloud Shell line): drawn as
// code with a copy button, since selecting a long line by hand is where a paste loses its first or last character.
const COMMAND_MIN = 60;
export const isCommand = (part: GuidePart): boolean => part.literal && part.text.trim().length >= COMMAND_MIN;

// Scopes lines lead with a translated prefix; its trailing space must live on the first catalog part, not after it.
export const guidePartsPrefixed = (prefix: string, line: string): readonly GuidePart[] => {
    // Guarded on the head itself, not on a length: a checked index is what makes the part below safe to read.
    const [first, ...rest] = guideParts(line);
    if (first === undefined) {
        return [{ text: prefix, literal: false }];
    }
    return [{ text: prefix, literal: false }, { text: ` ${first.text}`, literal: first.literal }, ...rest];
};
