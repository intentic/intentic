// The glyphs and colours the big picture and its peeks share (BigPictureFigure.astro, BigPicturePeeks.astro), so a
// sandbox is the same colour and a laptop the same drawing wherever it appears.
import type { BigPictureReach, BigPictureSandbox } from "@intentic/site-content/big-picture";

/** Each sandbox's own colour: a hue on the oklch wheel, mixed into whichever skin is on. */
export const HUE = { home: 62, game: 162, work: 248 } satisfies Record<BigPictureSandbox["id"], number>;

/** 24px line glyphs, drawn with currentColor. */
export const ICON = {
    browser: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9.5h18"/>',
    desktop: '<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M2.5 18.5h19"/>',
    phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 17.5h2"/>',
    os: '<path d="M12 3.5v7"/><path d="M6.8 6.8a7.3 7.3 0 1 0 10.4 0"/>',
    person: '<circle cx="12" cy="8.5" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    people: '<circle cx="9" cy="9" r="3.2"/><path d="M3 19.5a6 6 0 0 1 12 0"/><circle cx="17" cy="8" r="2.6"/><path d="M15.5 13.6A5 5 0 0 1 21 18.5"/>',
    laptop: '<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M2.5 18.5h19"/>',
    cloud: '<path d="M7 18.5h10a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 7.1 9.6 4.5 4.5 0 0 0 7 18.5z"/>',
    server: '<rect x="3.5" y="4.5" width="17" height="6" rx="2"/><rect x="3.5" y="13.5" width="17" height="6" rx="2"/><path d="M7 7.5h.01"/><path d="M7 16.5h.01"/>',
    box: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5"/><path d="M12 12v9"/>',
    relay: '<circle cx="12" cy="12" r="8.5"/><path d="M7.5 10h9l-2.5-2.5"/><path d="M16.5 14h-9l2.5 2.5"/>',
    agent: '<path d="m12 3 1.8 5 5 1.8-5 1.8L12 16.6l-1.8-5-5-1.8 5-1.8z"/>',
    home: '<path d="M4 11 12 4l8 7"/><path d="M6.5 9.5V20h11V9.5"/>',
    branch: '<circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="8.5" r="2"/><path d="M6 7.5v9"/><path d="M18 10.5c0 4-6 3-12 6"/>',
    wave: '<path d="M3 12h2"/><path d="M7.5 8v8"/><path d="M12 5v14"/><path d="M16.5 9v6"/><path d="M21 11v2"/>',
    drive: '<path d="M9 4h6l6 10.5-3 5.5H6l-3-5.5z"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
    close: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5"/><path d="m16 7 2.5 2.5"/><path d="m18.5 4.5 2 2"/>',
    lock: '<rect x="5" y="11" width="14" height="9.5" rx="2.5"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>',
    folder: '<path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h3.2l2 2.2h7.8A1.5 1.5 0 0 1 20 9.7v7.8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    eyeOff: '<path d="M4 4l16 16"/><path d="M9.9 5.8A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.6 3.4"/><path d="M6.4 7.5A15.8 15.8 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.2-1"/>',
    wrench: '<path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3z"/><path d="M14.5 6.5 17 4l3 3-2.5 2.5"/>',
    stored: '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6"/><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/><path d="M3 3l18 18"/>',
    moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
    arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
};

/** One glyph as inline SVG, sized and stroked. */
export const glyph = (paths: string, size = 14, width = 1.7): string =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const REACH_ICON = {
    laptop: ICON.laptop,
    phone: ICON.phone,
    assistant: ICON.home,
    server: ICON.server,
    github: ICON.branch,
    elevenlabs: ICON.wave,
    drive: ICON.drive,
} satisfies Record<BigPictureReach["id"], string>;

/** The glyph of the machine a sandbox runs on. */
export const hostIcon = (sandbox: BigPictureSandbox): string =>
    sandbox.host.kind === "hosted" ? ICON.cloud : sandbox.host.laptop ? ICON.laptop : ICON.server;
