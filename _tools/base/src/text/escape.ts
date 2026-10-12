// The small escapes and guards every tier kept its own copy of: a dozen `escapeRegExp`s and fifteen `isRecord`s, and
// HTML escapers that disagreed about the apostrophe (ONLYOFFICE's host page left `'` alone, which an attribute in
// single quotes needs). One spelling each, so a fix lands everywhere at once.

const HTML_ENTITIES = new Map([
    ["&", "&amp;"],
    ["<", "&lt;"],
    [">", "&gt;"],
    ['"', "&quot;"],
    ["'", "&#39;"],
]);

// Replaces the five characters that are active in HTML text and attribute contexts; safe for both template-literal HTML
// and v-html injection.
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (ch) => HTML_ENTITIES.get(ch) ?? ch);

// Every character a RegExp source reads as syntax, escaped, so the text matches only itself.
export const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

// A plain object to read keys off: not null, not an array. Says nothing about what the values are.
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
