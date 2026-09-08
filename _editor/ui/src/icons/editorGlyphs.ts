import type { Glyph } from "./glyph.js";

/** Code symbols and search toggles keep the familiar notation, drawn at the pack's own weight. */
export const EDITOR_GLYPHS = {
    "case-sensitive": { outline: `M2 19 7 5l5 14 M4 14h6 M21 19v-8h-4l-2 2v4l2 2h4` },
    "whole-word": { outline: `M2 15v6h20v-6 M7 16l5-12 5 12 M9 12h6` },
    regex: { outline: `M16 4v12 M11 7l10 6 M11 13l10-6`, solid: `M4 16h4v4H4Z` },
    replace: { outline: `M3 3h6v6H3Z M15 15h6v6h-6Z M13 6h5v6 M14 8l4 4 4-4 M11 18H3` },
    "replace-all": { outline: `M2 3h5v5H2Z M2 16h5v5H2Z M14 16h5v5h-5Z M11 5h7v7 M14 8l4 4 4-4 M10 18h1` },
    selection: { outline: `M8 3H3v5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5 M8 8h8v8H8Z` },
    move: { outline: `M12 2v20 M2 12h20 M8 6l4-4 4 4 M8 18l4 4 4-4 M6 8l-4 4 4 4 M18 8l4 4-4 4` },
    "expand-all": { outline: `M4 12h16 M8 7l4-4 4 4 M8 17l4 4 4-4` },
    "keyboard-tab": { outline: `M3 12h14 M12 7l5 5-5 5 M21 5v14` },
    "code-array": { outline: `M8 3H4v18h4 M16 3h4v18h-4` },
    "code-boolean": { outline: `M3 8l3 3 5-6 M14 13l7 7 M21 13l-7 7` },
    "code-class": { outline: `M3 4h18v16H3Z M3 10h18 M8 14h8` },
    "code-constant": { outline: `M4 7h16 M4 17h16 M4 4v6 M20 14v6` },
    "code-enum": { outline: `M10 6h11 M10 12h8 M10 18h5`, solid: `M3 4h3v4H3Z M3 10h3v4H3Z M3 16h3v4H3Z` },
    "code-function": { outline: `M18 4h-4l-2 2-3 12-2 2H4 M6 10h11` },
    "code-interface": { outline: `M7 3H3v18h4 M17 3h4v18h-4 M8 12h8` },
    "code-null": { outline: `M17 4 7 20 M18 12a6 8 0 1 1-12 0 6 8 0 0 1 12 0Z` },
    "code-number": { outline: `M9 3 7 21 M17 3l-2 18 M3 8h18 M2 16h18` },
    "code-object": { outline: `M8 3H6v6l-3 3 3 3v6h2 M16 3h2v6l3 3-3 3v6h-2` },
    "code-operator": { outline: `M4 7h8 M8 3v8 M14 17h8` },
    "code-string": { outline: `M3 4v5 M21 4v5 M6 20l6-14 6 14 M8 15h8` },
    "code-variable": { outline: `M5 5l14 14 M19 5 5 19 M2 21h20` },
    "code-parameter": { outline: `M6 5l-4 7 4 7 M18 5l4 7-4 7 M9 6h6 M12 6v12` },
} satisfies Record<string, Glyph>;
