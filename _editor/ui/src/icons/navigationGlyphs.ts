/** Khmer-inspired navigation: stepped lintels, cut corners, lotus points and lozenge joints.
 * Drawn for small controls on a 24-unit grid. Keep the silhouette specific to the section, leave at least
 * two units between strokes, and use solid cuts only where an outlined detail would close up.
 * This family also supplies the matching controls throughout the app. */
import type { Glyph } from "./glyph.js";

export const NAVIGATION_GLYPHS = {
    // A speaking tablet, with a cut tail and two lines of conversation.
    comments: {
        outline: `M5 4h14l2 2v10l-2 2h-8l-6 4v-4H3V6Z M7 9h10 M7 13h6`,
    },
    // A guardian's face: lotus crown, open eyes and a bevelled jaw.
    robot: {
        outline: `M5 9V6l4 1 3-4 3 4 4-1v3l2 2v5l-5 5H8l-5-5v-5Z M7 12h2 M15 12h2 M10 17h4`,
    },
    // One folder with a cut corner: an open interior keeps the file area easy to recognise.
    folder: {
        outline: `M3 5h6l3 3h9v10l-2 2H3Z`,
    },
    // The eye is a lotus petal in profile; a single diamond is enough for its pupil.
    eye: {
        outline: `M2 12c3-5 6-7 10-7s7 2 10 7c-3 5-6 7-10 7s-7-2-10-7Z`,
        solid: `m12 8 4 4-4 4-4-4Z`,
    },
    // A seal grants approval; the checklist beside it records acceptance criteria.
    approvals: {
        outline: `M8 3h8l5 5v8l-5 5H8l-5-5V8Z M7 12l3 3 7-7`,
    },
    "list-check": {
        outline: `M10 7h10 M10 17h10 M3 16l2 2 3-4`,
        solid: `m5 4 3 3-3 3-3-3Z`,
    },
    // Three stages along one continuous run, distinct from a workflow's fork.
    pipelines: {
        outline: `M7 6h10v3 M17 15v3H7 M3 6l2-3 2 3-2 3Z M15 12l2-3 2 3-2 3Z M3 18l2-3 2 3-2 3Z`,
    },
    // Lift a release from its base into service.
    deployments: {
        outline: `M12 15V3 M7 8l5-5 5 5 M3 14v4h3v3h12v-3h3v-4 M7 15h10`,
    },
    // A mason's chisel dressing a stone, rather than a settings wrench.
    maintenance: {
        outline: `m7 16 1-5L17 2l4 4-9 9Z M13 6l4 4 M3 14v7h16v-7 M5 17l2-1`,
    },
    sitemap: {
        outline: `M12 9v4 M5 17v-4h14v4 M9 5l3-3 3 3-3 3Z M2 19l3-3 3 3-3 3Z M16 19l3-3 3 3-3 3Z`,
    },
    // A scheduled orbit: a clock within a returning, angular arrow.
    automations: {
        outline: `M20 8 15 3H9L3 9v6l6 6h6l6-6 M20 3v5h-5 M12 7v5l3 2`,
    },
    // An open, bevel-edged manuscript.
    book: {
        outline: `M12 6 8 4H3v15h5l4 2 4-2h5V4h-5Z M12 6v15`,
    },
    // The supporting tiers of a temple: infrastructure beneath the work.
    infrastructure: {
        outline: `M3 21h18 M5 21v-4h14v4 M7 17v-4h10v4 M9 13V9h6v4 M12 3l4 3H8Z`,
    },
    "wave-pulse": {
        outline: `M2 13h5l3-7 4 13 3-6h5`,
        solid: `m19 3 2 2-2 2-2-2Z`,
    },
    // A browser window with a pointer, rather than the devices it runs on.
    browsers: {
        outline: `M10 20H5l-2-2V6l2-2h14l2 2v5 M3 9h18 M13 12v10l3-3h5Z`,
        solid: `M6 5.5 7.5 7 6 8.5 4.5 7Z`,
    },
    // Two staggered guardian faces: helpers share the Agents tile's face and pointed crown.
    subagents: {
        outline: `M3 10h3l2-3 2 3h3l2 2v6l-3 3H5l-3-3v-6Z M6 15h1 M10 15h1 M12 6h2l2-3 2 3h2l2 2v6l-3 3h-1 M18 11h1`,
    },
    // A wide, unframed command prompt.
    terminal: {
        outline: `M4 7l6 5-6 5 M14 17h6`,
    },
    vpn: {
        outline: `m12 3 8 3v7l-3 5-5 3-5-3-3-5V6Z M9 12V9a3 3 0 0 1 6 0v3 M8 12h8v5H8Z`,
    },
    // A route through an open gateway: something in the sandbox is publicly reachable.
    ports: {
        outline: `M3 21V7h3V4h9v3h3 M7 21V9h7v3 M11 16h11 M18 12l4 4-4 4`,
    },
    // The familiar add action needs only a plus.
    plus: {
        outline: `M12 4v16 M4 12h16`,
    },
    ellipsis: {
        outline: ``,
        solid: `m4 10 2 2-2 2-2-2Z m8 0 2 2-2 2-2-2Z m8 0 2 2-2 2-2-2Z`,
    },
    bars: {
        outline: `M9 5h12 M9 12h12 M9 19h12`,
        solid: `m4 3 2 2-2 2-2-2Z m0 7 2 2-2 2-2-2Z m0 7 2 2-2 2-2-2Z`,
    },
    "exclamation-triangle": {
        outline: `M12 3 22 20H2Z M12 9v5`,
        solid: `m12 16 1.5 1.5L12 19l-1.5-1.5Z`,
    },
} satisfies Record<string, Glyph>;
