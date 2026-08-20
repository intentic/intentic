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
