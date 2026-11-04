// A model's name as a compact chip draws it: "Claude Opus 5.5" reads "Opus 5.5". Anthropic's family names are its own,
// so the brand word only repeats what the logo or provider beside it already says. Display only: every label the app
// hands on (a pick's result, the extension API, search, a notice's sentence, the usage ledger) stays modelLabelFor's
// full name, and a chip that shortens keeps the full name in its hover.
//
// Only a brand followed by a family word and a version is dropped: "Claude Code" (a runtime), "Claude 3.5 Sonnet" (the
// old order) and every other vendor's label pass through unchanged, since "Grok Code Fast 1" without its brand, or
// "3.8 Flash" without "Gemini", no longer names anything.
const FAMILY_BRAND = /^Claude (?=[A-Z][a-z]+ \d)/;

export const shortModelLabel = (label: string): string => label.replace(FAMILY_BRAND, ``);
