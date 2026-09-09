import type { Glyph } from "./glyph.js";

/** State symbols use familiar silhouettes, generous counters and the same carved line as navigation. */
export const STATUS_GLYPHS = {
    check: { outline: `m4 12 5 5L20 6` },
    "check-circle": { outline: `M8 3h8l5 5v8l-5 5H8l-5-5V8Z M7 12l3 3 7-7` },
    "check-square": { outline: `M21 12v9H3V3h12 M8 10l4 4 9-9` },
    circle: { outline: `M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z` },
    "circle-fill": { outline: ``, solid: `M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z` },
    clock: { outline: `M8 3h8l5 5v8l-5 5H8l-5-5V8Z M12 7v5l4 2` },
    "exclamation-circle": { outline: `M8 3h8l5 5v8l-5 5H8l-5-5V8Z M12 7v6`, solid: `M11 16h2v2h-2Z` },
    "info-circle": { outline: `M8 3h8l5 5v8l-5 5H8l-5-5V8Z M11 11h1v6 M10 17h4`, solid: `M11 6h2v2h-2Z` },
    "question-circle": { outline: `M8 3h8l5 5v8l-5 5H8l-5-5V8Z M9 8c0-3 6-3 6 0 0 2-3 2-3 5`, solid: `M11 16h2v2h-2Z` },
    "plus-circle": { outline: `M8 3h8l5 5v8l-5 5H8l-5-5V8Z M12 7v10 M7 12h10` },
    square: { outline: `M3 3h18v18H3Z` },
    stop: { outline: ``, solid: `M5 4h14l1 1v14l-1 1H5l-1-1V5Z` },
    // The one glyph that turns, so it is drawn for motion rather than for silhouette: a 140° arc on the same 20-unit
    // outer circle as `circle`, ridden over a still track and thickened by Icon (see Icon.vue). A three-quarter
    // hairline — what this was — is a shape whose every pixel is re-antialiased on every frame, which at 11px reads as
    // a stutter rather than a turn.
    spinner: { outline: `M12 3.25a8.75 8.75 0 0 1 5.624 15.453` },
    star: { outline: `m12 2 3 7 7 1-5 5 1 7-6-4-6 4 1-7-5-5 7-1Z` },
    "star-fill": { outline: ``, solid: `m12 2 3 7 7 1-5 5 1 7-6-4-6 4 1-7-5-5 7-1Z` },
    bolt: { outline: `M14 2 4 14h7l-1 8 10-12h-7Z` },
    sparkles: { outline: `M10 3c1 5 3 7 7 8-4 1-6 3-7 8-1-5-3-7-7-8 4-1 6-3 7-8Z M20 3v4 M18 5h4` },
    history: { outline: `M3 3v6h6 M3 9l6-6h6l6 6v6l-6 6H9l-5-5 M12 7v5l4 2` },
    shield: { outline: `m12 3 8 3v7l-3 5-5 3-5-3-3-5V6Z M8 12l3 3 5-6` },
    lock: { outline: `M5 11h14v10H5Z M8 11V6a4 4 0 0 1 8 0v5 M12 15v2` },
    unlock: { outline: `M5 11h14v10H5Z M8 11V6a4 4 0 0 1 8 0 M12 15v2` },
    wifi: { outline: `M2 7c6-5 14-5 20 0 M6 12c4-3 8-3 12 0 M9 16c2-1 4-1 6 0`, solid: `m12 19 2 2-2 2-2-2Z` },
    sun: { outline: `M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1 1 M18 18l1 1 M5 19l1-1 M18 6l1-1` },
    moon: { outline: `M21 14a9 9 0 0 1-11-11 9 9 0 1 0 11 11Z` },
    "volume-up": { outline: `M3 9h4l6-5v16l-6-5H3Z M17 8c2 2 2 6 0 8 M19 4c4 4 4 12 0 16` },
    "volume-off": { outline: `M3 9h4l6-5v16l-6-5H3Z M17 9l5 6 M22 9l-5 6` },
} satisfies Record<string, Glyph>;
