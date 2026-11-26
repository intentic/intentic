// SPDX-License-Identifier: AGPL-3.0-only
// Intentic's. The media player's control bar as it is drawn: its labels in the editor's languages, its stylesheet and
// its icons, and the clock it shows.

// `m:ss` for a time in seconds.
export const clockOf = (seconds: number): string => {
    const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, `0`)}`;
};

// The control bar's labels, in the editor's interface languages that Intentic has; English otherwise.
export interface Labels {
    readonly play: string;
    readonly pause: string;
    readonly mute: string;
    readonly unmute: string;
    readonly seek: string;
}

const LABELS = new Map<string, Labels>([
    [`en`, { play: `Play`, pause: `Pause`, mute: `Mute`, unmute: `Unmute`, seek: `Position` }],
    [`pl`, { play: `Odtwórz`, pause: `Wstrzymaj`, mute: `Wycisz`, unmute: `Włącz dźwięk`, seek: `Pozycja` }],
    [`de`, { play: `Abspielen`, pause: `Pause`, mute: `Stummschalten`, unmute: `Ton an`, seek: `Position` }],
    [`es`, { play: `Reproducir`, pause: `Pausa`, mute: `Silenciar`, unmute: `Activar sonido`, seek: `Posición` }],
    [`fr`, { play: `Lire`, pause: `Pause`, mute: `Couper le son`, unmute: `Rétablir le son`, seek: `Position` }],
]);

const ENGLISH: Labels = { play: `Play`, pause: `Pause`, mute: `Mute`, unmute: `Unmute`, seek: `Position` };

export const labelsFor = (lang: string): Labels => LABELS.get(lang.split(/[-_]/)[0]?.toLowerCase() ?? ``) ?? ENGLISH;

// Above the slideshow (its container stacks at 1003) and every panel of the editor.
const Z_INDEX = 2_147_483_000;

export const STYLE_ID = `oo-media-player-css`;
export const STYLE = [
    `#oo-media-player { position: fixed; inset: 0; pointer-events: none; z-index: ${Z_INDEX}; }`,
    `#oo-media-player .stage { position: absolute; display: none; background: #000; }`,
    `#oo-media-player video { width: 100%; height: 100%; object-fit: fill; display: block; }`,
    `#oo-media-player .bar { position: absolute; display: none; box-sizing: border-box; align-items: center; gap: 8px; padding: 0 10px;`,
    `  border-radius: 6px; pointer-events: auto; font: 12px/1 Arial, Helvetica, sans-serif; user-select: none;`,
    `  background: rgba(255, 255, 255, 0.94); color: #333; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3); }`,
    `#oo-media-player .bar[data-theme="dark"] { background: rgba(48, 48, 48, 0.94); color: #eee; }`,
    `#oo-media-player button { all: unset; display: inline-flex; width: 24px; height: 24px; align-items: center; justify-content: center;`,
    `  border-radius: 4px; cursor: pointer; }`,
    `#oo-media-player button:hover { background: rgba(127, 127, 127, 0.2); }`,
    `#oo-media-player button:focus-visible { outline: 2px solid #4a90e2; }`,
    `#oo-media-player button:disabled { opacity: 0.4; cursor: default; }`,
    `#oo-media-player svg { width: 16px; height: 16px; fill: currentColor; stroke: currentColor; }`,
    `#oo-media-player input[type="range"] { flex: 1; min-width: 40px; margin: 0; accent-color: #4a90e2; cursor: pointer; }`,
    `#oo-media-player .time { white-space: nowrap; font-variant-numeric: tabular-nums; }`,
].join(`\n`);

// SVG paths on a 24-unit grid: filled shapes, and strokes for the mute cross.
export const ICONS = {
    play: { fill: [`M8 5v14l11-7z`], stroke: [] },
    pause: { fill: [`M6 5h4v14H6z`, `M14 5h4v14h-4z`], stroke: [] },
    sound: { fill: [`M3 9v6h4l5 5V4L7 9H3z`, `M16.5 12A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z`], stroke: [] },
    muted: { fill: [`M3 9v6h4l5 5V4L7 9H3z`], stroke: [`M16 9l5 6`, `M21 9l-5 6`] },
} satisfies Record<string, { fill: readonly string[]; stroke: readonly string[] }>;

const SVG = `http://www.w3.org/2000/svg`;

export const iconOf = (doc: Document, icon: (typeof ICONS)[keyof typeof ICONS]): SVGSVGElement => {
    const svg = doc.createElementNS(SVG, `svg`);
    svg.setAttribute(`viewBox`, `0 0 24 24`);
    svg.setAttribute(`aria-hidden`, `true`);
    for (const d of icon.fill) {
        const path = doc.createElementNS(SVG, `path`);
        path.setAttribute(`d`, d);
        path.setAttribute(`stroke`, `none`);
        svg.append(path);
    }
    for (const d of icon.stroke) {
        const path = doc.createElementNS(SVG, `path`);
        path.setAttribute(`d`, d);
        path.setAttribute(`fill`, `none`);
        path.setAttribute(`stroke-width`, `2`);
        path.setAttribute(`stroke-linecap`, `round`);
        svg.append(path);
    }
    return svg;
};
