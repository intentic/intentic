import type { Glyph } from "./glyph.js";

/** Form and window controls use open silhouettes so their state stays clear at small sizes. */
export const CONTROL_GLYPHS = {
    "arrow-down": { outline: `M12 3v18 M6 15l6 6 6-6` },
    "arrow-up": { outline: `M12 21V3 M6 9l6-6 6 6` },
    ban: { outline: `M8 3h8l5 5v8l-5 5H8l-5-5V8Z M5 5l14 14` },
    calendar: { outline: `M3 5h18v14l-2 2H3Z M3 10h18 M8 2v5 M16 2v5 M8 15h3 M15 15h1` },
    "chevron-left": { outline: `m15 6-6 6 6 6` },
    "chevrons-down": { outline: `m6 4 6 6 6-6 M6 13l6 6 6-6` },
    "chevrons-left": { outline: `m11 6-6 6 6 6 M20 6l-6 6 6 6` },
    "chevrons-right": { outline: `m4 6 6 6-6 6 M13 6l6 6-6 6` },
    "chevrons-up": { outline: `m6 11 6-6 6 6 M6 20l6-6 6 6` },
    "filter-slash": { outline: `M9 4h12l-6 7 M3 3l18 18 M3 8l7 7v6l4-2v-4` },
    minus: { outline: `M4 12h16` },
    "search-minus": { outline: `M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z M15 15l6 6 M7 10h6` },
    "search-plus": { outline: `M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z M15 15l6 6 M7 10h6 M10 7v6` },
    sort: { outline: `M7 3v18 M3 7l4-4 4 4 M17 21V3 M13 17l4 4 4-4` },
    "sort-asc": { outline: `M4 5h6 M4 12h11 M4 19h16` },
    "times-circle": { outline: `M8 3h8l5 5v8l-5 5H8l-5-5V8Z M8 8l8 8 M16 8l-8 8` },
    restore: { outline: `M7 7h14v14H7Z M3 17V3h14` },
} satisfies Record<string, Glyph>;
