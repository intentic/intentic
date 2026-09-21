// ponytail: standalone theme module (not inlined): reused by any code block, keeps pages clean.
// Untyped literal: shiki is only a transitive dep (bundled by Astro's <Code>), so its types aren't
// importable here: the <Code theme={...}> call site type-checks this object's shape instead.
// Warm, low-chroma syntax theme keyed to the site palette: the neutrals are the cream, muted and subtle
// inks from global.css, so a code block belongs to the same wall as the prose around it.
// Keywords carry the single brand-orange signal; everything else is warm neutrals/tans: code reads
// as "engineered terminal", not a rainbow. Background is transparent so the .code-window frame shows.
export const intenticWarm = {
    name: "intentic-warm",
    type: "dark" as const,
    bg: "transparent",
    fg: "#e2d6c2",
    settings: [
        { settings: { foreground: "#e2d6c2", background: "transparent" } },
        { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#8b7f6c", fontStyle: "italic" } },
        {
            scope: [
                "keyword",
                "keyword.control",
                "keyword.operator.new",
                "keyword.operator.expression",
                "storage",
                "storage.type",
                "storage.modifier",
                "modifier",
            ],
            settings: { foreground: "#ef8c3e" },
        },
        {
            scope: ["constant.numeric", "constant.language", "constant.language.boolean", "support.constant"],
            settings: { foreground: "#e77a22" },
        },
        { scope: ["string", "string.quoted", "string.template", "constant.other.symbol"], settings: { foreground: "#c9a06a" } },
        { scope: ["punctuation.definition.string"], settings: { foreground: "#a6864f" } },
        {
            scope: ["entity.name.type", "support.type", "support.class", "entity.name.class", "entity.other.inherited-class"],
            settings: { foreground: "#e8b894" },
        },
        { scope: ["entity.name.function", "support.function", "meta.function-call.generic"], settings: { foreground: "#f6ecd9" } },
        { scope: ["variable", "variable.other", "meta.definition.variable", "variable.parameter"], settings: { foreground: "#e2d6c2" } },
        {
            scope: ["meta.object-literal.key", "support.type.property-name", "variable.other.property", "entity.name.tag"],
            settings: { foreground: "#b0a28b" },
        },
        {
            scope: ["punctuation", "meta.brace", "keyword.operator", "punctuation.separator", "punctuation.terminator"],
            settings: { foreground: "#8b7f6c" },
        },
    ],
};

// The maker skin's half of the pair. Same scopes in the same order, same idea — one brand-orange signal on keywords,
// warm neutrals for everything else — inverted for paper: prominence here is depth, not brightness. Every colour
// clears 4.5:1 on the light code ground (#f7f4ef, the app's own light terminal), so a snippet is readable and not
// merely tinted. Shipped alongside the dark theme rather than instead of it: `<Code>` emits both, the dark one
// inline and this one as `--shiki-light`, and maker.css switches between them.
export const intenticPaper = {
    name: "intentic-paper",
    type: "light" as const,
    bg: "transparent",
    fg: "#29201a",
    settings: [
        { settings: { foreground: "#29201a", background: "transparent" } },
        { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#78665c", fontStyle: "italic" } },
        {
            scope: [
                "keyword",
                "keyword.control",
                "keyword.operator.new",
                "keyword.operator.expression",
                "storage",
                "storage.type",
                "storage.modifier",
                "modifier",
            ],
            settings: { foreground: "#9e4502" },
        },
        {
            scope: ["constant.numeric", "constant.language", "constant.language.boolean", "support.constant"],
            settings: { foreground: "#84390d" },
        },
        { scope: ["string", "string.quoted", "string.template", "constant.other.symbol"], settings: { foreground: "#75551c" } },
        { scope: ["punctuation.definition.string"], settings: { foreground: "#7d5f26" } },
        {
            scope: ["entity.name.type", "support.type", "support.class", "entity.name.class", "entity.other.inherited-class"],
            settings: { foreground: "#8a4f2a" },
        },
        { scope: ["entity.name.function", "support.function", "meta.function-call.generic"], settings: { foreground: "#3b2a1c" } },
        { scope: ["variable", "variable.other", "meta.definition.variable", "variable.parameter"], settings: { foreground: "#29201a" } },
        {
            scope: ["meta.object-literal.key", "support.type.property-name", "variable.other.property", "entity.name.tag"],
            settings: { foreground: "#62564e" },
        },
        {
            scope: ["punctuation", "meta.brace", "keyword.operator", "punctuation.separator", "punctuation.terminator"],
            settings: { foreground: "#78665c" },
        },
    ],
};

/** Both skins' themes, in the shape `<Code themes={...}>` wants. Dark is the default, so it stays the inline colour. */
export const intenticThemes = { light: intenticPaper, dark: intenticWarm };
