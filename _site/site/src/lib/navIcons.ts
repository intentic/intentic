// THE NAV MENUS' GLYPHS, keyed by subject the way the app keys its rail (AREA_ICONS in _editor/ui/src/icons/iconSets.ts):
// the data layer names a subject, the drawing lives here, and a missing key draws nothing.
//
// Same grammar as the app's own pack (_editor/ui/src/icons/navigationGlyphs.ts): a 24-unit grid, square caps, mitred
// joins, cut corners, stepped lintels and lozenge joints, no circles. Where the app already draws the subject (chat,
// automations, approvals, infrastructure, the book, workflows, ports, extensions) the line starts from the app's
// drawing, so a row here and its tile in the product look like the same thing. The menu draws them at almost twice
// the rail's size, so each one is built in up to four layers rather than the rail's one line:
//   plane  the body, filled at a low alpha (`--role-glyph-plane`)
//   line   the gilt stroke (`url(#nav-gilt)`, defined once in Nav.astro)
//   spark  a stroke in the ember, for the one part that IS the meaning (the approval's tick)
//   jewel  a small ember solid, the lit mark. Ember stays a small mark, never a fill (house.css).

export interface NavGlyph {
    plane?: string;
    line: string;
    spark?: string;
    jewel?: string;
}

const NAV_GLYPHS = {
    // Features.
    // The app's helpers glyph: two staggered guardian faces, the front one wearing the jewel.
    agents: {
        plane: `M3 10h3l2-3 2 3h3l2 2v6l-3 3H5l-3-3v-6Z`,
        line: `M3 10h3l2-3 2 3h3l2 2v6l-3 3H5l-3-3v-6Z M12 6h2l2-3 2 3h2l2 2v6l-3 3h-1 M5.5 15.5h1.5 M9 15.5h1.5 M18.5 10.5h1`,
        jewel: `m8 10.4 1.4 1.4L8 13.2l-1.4-1.4Z`,
    },
    // The app's link: two cut-corner links, the joint between them a jewel. Features and Docs share it, as one subject.
    integrations: {
        line: `M7 13l-3 3v3l2 2h3l4-4 M11 7l4-4h3l3 3v3l-3 3 M8.5 15.5l1.6-1.6 M13.9 10.1l1.6-1.6`,
        jewel: `m12 9.6 2.4 2.4-2.4 2.4-2.4-2.4Z`,
    },
    // The app's automations: an octagonal dial inside its returning arrow, the hub lit.
    automations: {
        plane: `M15 3H9L3 9v6l6 6h6l6-6V9Z`,
        line: `M20 8 15 3H9L3 9v6l6 6h6l6-6 M20 3v5h-5 M12 7v4 M13.2 12.8l2.8 1.9`,
        jewel: `m12 10.4 1.6 1.6-1.6 1.6-1.6-1.6Z`,
    },
    // The app's approvals seal. The tick is the meaning, so it is the part in the ember.
    approvals: {
        plane: `M8 3h8l5 5v8l-5 5H8l-5-5V8Z`,
        line: `M8 3h8l5 5v8l-5 5H8l-5-5V8Z`,
        spark: `M7.5 12l3 3 6-6`,
    },
    // The app's infrastructure: a temple's tiers on your own ground, the shrine at the top lit.
    "self-hosting": {
        plane: `M5 21v-4h14v4Z M7 17v-4h10v4Z M9 13V9h6v4Z`,
        line: `M3 21h18 M5 21v-4h14v4 M7 17v-4h10v4 M9 13V9h6v4`,
        jewel: `M12 3l4 3.6H8Z`,
    },

    // Docs.
    // The app's manuscript, with lines on its pages and a lotus point above the spine.
    learn: {
        plane: `M12 7 8 5H3v14h5l4 2 4-2h5V5h-5Z`,
        line: `M12 7 8 5H3v14h5l4 2 4-2h5V5h-5Z M12 7v14 M6 9h3 M6 12.5h3 M15 9h3 M15 12.5h3`,
        jewel: `m12 1.2 1.6 1.6L12 4.4l-1.6-1.6Z`,
    },
    // The app's box, its lid lit from inside: something running in it.
    sandbox: {
        plane: `m12 3 9 5-9 5-9-5Z`,
        line: `m12 3 9 5v9l-9 5-9-5V8Z M3 8l9 5 9-5 M12 13v9`,
        jewel: `m12 6.4 2.4 1.6L12 9.6 9.6 8Z`,
    },
    // The app's workflows: lozenge nodes on one lintel, the conductor at the top lit.
    orchestration: {
        plane: `M2 19l3-3 3 3-3 3Z M16 19l3-3 3 3-3 3Z`,
        line: `M12 9v4 M5 16v-3h14v3 M2 19l3-3 3 3-3 3Z M16 19l3-3 3 3-3 3Z`,
        jewel: `M8.6 5.5 12 2.1l3.4 3.4L12 8.9Z`,
    },

    // Resources.
    // A compass rose of four lotus points around a jewel.
    guides: {
        plane: `M12 2l2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6Z`,
        line: `M12 2l2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6Z`,
        jewel: `m12 10 2 2-2 2-2-2Z`,
    },
    // A pen nib on its collar, the vent a jewel.
    blog: {
        plane: `M8 6h8l3 7-7 9-7-9Z`,
        line: `M8 2h8v4H8Z M8 6h8l3 7-7 9-7-9Z M12 22v-7.4`,
        jewel: `m12 10.4 1.8 1.8-1.8 1.8-1.8-1.8Z`,
    },
    // A balance on a lotus pivot, its two pans cut like the rest.
    compare: {
        plane: `M1.5 13h6l-1.5 2.6H3Z M16.5 13h6l-1.5 2.6h-3Z`,
        line: `M12 6v15 M8 21h8 M4.5 7h15 M4.5 7 2 13 M4.5 7 7 13 M19.5 7 17 13 M19.5 7 22 13 M1.5 13h6l-1.5 2.6H3Z M16.5 13h6l-1.5 2.6h-3Z`,
        jewel: `m12 1.6 2 2-2 2-2-2Z`,
    },
    // An inscribed stele on its plinth: what shipped, cut where it stays.
    changelog: {
        plane: `M6 21V8.5l6-5.5 6 5.5V21Z`,
        line: `M6 21V8.5l6-5.5 6 5.5V21 M3.5 21h17 M9 12h6 M9 15h6 M9 18h3.5`,
        jewel: `m12 6.2 1.5 1.5L12 9.2l-1.5-1.5Z`,
    },
    // The app's speaking tablet, someone mid-sentence on its second line.
    community: {
        plane: `M5 4h14l2 2v10l-2 2h-8l-6 4v-4H3V6Z`,
        line: `M5 4h14l2 2v10l-2 2h-8l-6 4v-4H3V6Z M7 9h10 M7 13h5`,
        jewel: `m15.5 11.6 1.4 1.4-1.4 1.4-1.4-1.4Z`,
    },

    // Developers.
    // Code brackets around a set stone: what you write, and the thing it becomes.
    code: {
        line: `m8 5-6 7 6 7 M16 5l6 7-6 7 M12 7.2l4.8 4.8-4.8 4.8L7.2 12Z`,
        jewel: `m12 10 2 2-2 2-2-2Z`,
    },
    // The app's ports: the one socket every call comes through.
    api: {
        plane: `M5 3h14l2 2v12h-5v4H8v-4H3V5Z`,
        line: `M5 3h14l2 2v12h-5v4H8v-4H3V5Z M8 7v3 M12 7v3 M16 7v3`,
        jewel: `m12 15.2 1.6 1.6-1.6 1.6-1.6-1.6Z`,
    },
    // The app's extensions: the plug, lit where it carries current.
    extensions: {
        plane: `M5 8h14v5l-4 4H9l-4-4Z`,
        line: `M8 2v6 M16 2v6 M5 8h14v5l-4 4H9l-4-4Z M12 17v5`,
        jewel: `m12 9.4 1.6 1.6-1.6 1.6-1.6-1.6Z`,
    },
} satisfies Record<string, NavGlyph>;

/** A subject this file draws. The data layer's keys are open strings, so the check below is what narrows one. */
type NavGlyphName = keyof typeof NAV_GLYPHS;

const isNavGlyphName = (key: string): key is NavGlyphName => Object.hasOwn(NAV_GLYPHS, key);

/** The inside of one glyph's `<svg viewBox="0 0 24 24">`, layer by layer; empty for an unknown key. */
export function navGlyphMarkup(key: string | undefined): string {
    if (key === undefined || !isNavGlyphName(key)) {
        return ``;
    }
    const glyph: NavGlyph = NAV_GLYPHS[key];
    return [
        glyph.plane && `<path class="glyph-plane" d="${glyph.plane}"/>`,
        `<path class="glyph-line" d="${glyph.line}"/>`,
        glyph.spark && `<path class="glyph-spark" d="${glyph.spark}"/>`,
        glyph.jewel && `<path class="glyph-jewel" d="${glyph.jewel}"/>`,
    ]
        .filter(Boolean)
        .join(``);
}
