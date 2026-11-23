// SPDX-License-Identifier: AGPL-3.0-only
// Intentic's. The presentation editor plays a slide's audio and video only in ONLYOFFICE's desktop app: it describes
// what to show (the medium, where it sits on screen, play or pause) to callMediaPlayerCommand, which hands that to the
// app's native player and does nothing anywhere else. This answers it in the browser: an HTML media element laid over
// the medium's picture, and a control bar where the editor places the desktop app's.
import type { MediaProblem } from "../../../src/protocol.js";

// A rectangle in the editor frame's CSS pixels.
export interface Rect {
    readonly X: number;
    readonly Y: number;
    readonly W: number;
    readonly H: number;
}

// What the editor says about the medium with each command (the API's getPlayerData).
export interface PlayerData {
    readonly Cmd?: string;
    readonly MediaFile?: string | null;
    readonly FrameRect?: Rect;
    readonly ControlRect?: Rect;
    readonly Rotation?: number;
    readonly FlipH?: boolean;
    readonly FlipV?: boolean;
    readonly Mute?: boolean;
    // A slideshow's volume for the medium, in thousandths of a percent (80000 is 80%).
    readonly Volume?: number | null;
    readonly IsVideo?: boolean;
    readonly FullScreen?: boolean;
    readonly Theme?: string;
}

// What a command asks of the player.
export type PlayerAction =
    | { readonly kind: "hide" }
    // Show the controls where the data says (a medium selected, or hovered in a slideshow), or follow it there.
    | { readonly kind: "show" }
    | { readonly kind: "play"; readonly from: number | undefined }
    | { readonly kind: "pause" }
    | { readonly kind: "stop" }
    | { readonly kind: "toggle" };

const PLAY_FROM = /^playFrom\((\d+(?:\.\d+)?)\)$/;

export const actionOf = (command: string): PlayerAction => {
    switch (command) {
        case `hideMediaControl`:
            return { kind: `hide` };
        case `play`:
        case `resume`:
            return { kind: `play`, from: undefined };
        case `pause`:
            return { kind: `pause` };
        case `stop`:
            return { kind: `stop` };
        case `togglePause`:
            return { kind: `toggle` };
        default: {
            const from = PLAY_FROM.exec(command)?.[1];
            return from === undefined ? { kind: `show` } : { kind: `play`, from: Number(from) };
        }
    }
};

// The medium's own transform: its rotation (radians) and flips, about its centre.
export const transformOf = (data: Pick<PlayerData, "Rotation" | "FlipH" | "FlipV">): string =>
    `rotate(${data.Rotation ?? 0}rad) scale(${data.FlipH === true ? -1 : 1}, ${data.FlipV === true ? -1 : 1})`;

// A volume between 0 and 1 from the editor's thousandths of a percent; full where it gives none.
export const volumeOf = (volume: number | null | undefined): number => (volume === null || volume === undefined ? 1 : Math.min(1, Math.max(0, volume / 100_000)));

// `m:ss` for a time in seconds.
export const clockOf = (seconds: number): string => {
    const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, `0`)}`;
};

// The control bar's labels, in the editor's interface languages that Intentic has; English otherwise.
interface Labels {
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

// While the player is showing, how often it asks the editor where the medium is now: the editor says so on scroll and
// zoom, but not when the slideshow moves on or the shape is dragged.
const FOLLOW_MS = 250;
// Above the slideshow (its container stacks at 1003) and every panel of the editor.
const Z_INDEX = 2_147_483_000;

const STYLE_ID = `oo-media-player-css`;
const STYLE = [
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
const ICONS = {
    play: { fill: [`M8 5v14l11-7z`], stroke: [] },
    pause: { fill: [`M6 5h4v14H6z`, `M14 5h4v14h-4z`], stroke: [] },
    sound: { fill: [`M3 9v6h4l5 5V4L7 9H3z`, `M16.5 12A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z`], stroke: [] },
    muted: { fill: [`M3 9v6h4l5 5V4L7 9H3z`], stroke: [`M16 9l5 6`, `M21 9l-5 6`] },
} satisfies Record<string, { fill: readonly string[]; stroke: readonly string[] }>;

const SVG = `http://www.w3.org/2000/svg`;

const iconOf = (doc: Document, icon: (typeof ICONS)[keyof typeof ICONS]): SVGSVGElement => {
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

// The vendor's media handle: the picture the medium belongs to, and that picture's slide.
export interface MediaData {
    getDrawing?: () => { parent?: object | null } | null;
}

export interface PlayerApi {
    mediaData?: MediaData | null;
    callMediaPlayerCommand?: (command: string | null | undefined, data: MediaData | null) => void;
    getPlayerData?: (command: string) => PlayerData | null;
    WordControl?: {
        // Only the presentation editor's has it: what tells this guard it is in one.
        GetMediaPlayerData?: unknown;
        DemonstrationManager?: { Mode?: boolean; SlideNum?: number };
        m_oLogicDocument?: { CurPage?: number; Slides?: readonly object[] };
    };
}

interface DocumentUrls {
    getImageUrl?: (name: string) => string | null | undefined;
}

interface PlayerWindow {
    Asc?: { editor?: PlayerApi };
    AscCommon?: { g_oDocumentUrls?: DocumentUrls };
}

export interface PlayerHooks {
    // A medium of the document this browser cannot play: said once per medium.
    readonly mediaProblem: (problem: MediaProblem) => void;
    readonly lang: string;
}

type Movable = Element & { moveBefore?: (node: Node, child: Node | null) => void };

// The parts of the player, built in the frame's document on its first command.
interface Parts {
    readonly host: HTMLDivElement;
    readonly stage: HTMLDivElement;
    readonly media: HTMLVideoElement;
    readonly bar: HTMLDivElement;
    readonly play: HTMLButtonElement;
    readonly time: HTMLSpanElement;
    readonly seek: HTMLInputElement;
    readonly mute: HTMLButtonElement;
}

// Events the bar keeps from the editor under it: a click on the bar is not a click on the slide.
const KEPT_EVENTS = [`pointerdown`, `pointerup`, `mousedown`, `mouseup`, `click`, `dblclick`, `contextmenu`, `wheel`, `touchstart`, `keydown`, `keyup`];

class MediaPlayer {
    private parts: Parts | undefined;
    private file: string | undefined;
    private data: PlayerData | undefined;
    private controls = false;
    private follow: number | undefined;
    // The slide the medium was shown on, and whether in a slideshow: the slideshow moving on, or ending, leaves the
    // editor reporting the medium where it was.
    private slide: object | undefined;
    private shownInSlideshow = false;
    private readonly told = new Set<string>();
    private readonly labels: Labels;

    constructor(
        private readonly frame: Window,
        private readonly api: PlayerApi,
        private readonly urls: DocumentUrls,
        private readonly hooks: PlayerHooks,
    ) {
        this.labels = labelsFor(hooks.lang);
    }

    command(command: string, data: PlayerData | null): void {
        const action = actionOf(command);
        if (action.kind === `hide` || data?.FrameRect === undefined || data.ControlRect === undefined) {
            this.hide();
            return;
        }
        // An update follows what shows; it never brings back what was let go, nor carries it out of a slideshow.
        if (command === `update` && (this.data === undefined || this.inSlideshow() !== this.shownInSlideshow)) {
            this.letGo();
            return;
        }
        const parts = this.build();
        if (parts === undefined || !this.load(parts, data)) {
            this.hide();
            return;
        }
        this.data = data;
        this.slide = this.drawingSlide();
        this.shownInSlideshow = this.inSlideshow();
        switch (action.kind) {
            case `show`:
                this.controls = true;
                break;
            case `play`:
                if (action.from !== undefined) {
                    parts.media.currentTime = action.from;
                }
                this.start(parts);
                break;
            case `pause`:
                parts.media.pause();
                break;
            case `stop`:
                parts.media.pause();
                parts.media.currentTime = 0;
                break;
            case `toggle`:
                this.toggle(parts);
                break;
        }
        parts.media.muted = data.Mute === true;
        if (this.inSlideshow()) {
            parts.media.volume = volumeOf(data.Volume);
        }
        this.layout(parts, data);
        this.keepFollowing();
    }

    private inSlideshow(): boolean {
        return this.api.WordControl?.DemonstrationManager?.Mode === true;
    }

    private drawingSlide(): object | undefined {
        return this.api.mediaData?.getDrawing?.()?.parent ?? undefined;
    }

    // Whether the medium's slide is still the one on screen; true where the editor does not say.
    private onItsSlide(): boolean {
        const control = this.api.WordControl;
        const index = this.inSlideshow() ? control?.DemonstrationManager?.SlideNum : control?.m_oLogicDocument?.CurPage;
        const slides = control?.m_oLogicDocument?.Slides;
        if (this.slide === undefined || index === undefined || slides === undefined) {
            return true;
        }
        return slides[index] === this.slide;
    }

    // Points the media element at the document's medium; false where the document holds no such medium.
    private load(parts: Parts, data: PlayerData): boolean {
        const file = data.MediaFile ?? undefined;
        const url = file === undefined ? undefined : this.urls.getImageUrl?.(file);
        if (file === undefined || url === undefined || url === null || url === ``) {
            return false;
        }
        if (file !== this.file) {
            this.file = file;
            parts.media.src = url;
            parts.play.disabled = false;
        }
        return true;
    }

    private start(parts: Parts): void {
        parts.media.play().catch((error: Error) => {
            // A pause or a new source before playback began rejects too; only a medium that cannot play is told.
            if (error.name === `NotSupportedError`) {
                this.unplayable(parts);
            }
        });
    }

    private toggle(parts: Parts): void {
        if (parts.media.paused) {
            this.start(parts);
        } else {
            parts.media.pause();
        }
    }

    private unplayable(parts: Parts): void {
        parts.play.disabled = true;
        const file = this.file;
        if (file !== undefined && !this.told.has(file)) {
            this.told.add(file);
            this.hooks.mediaProblem(`unplayable`);
        }
        this.refresh(parts);
    }

    hide(): void {
        const parts = this.parts;
        this.controls = false;
        this.data = undefined;
        if (this.follow !== undefined) {
            this.frame.clearInterval(this.follow);
            this.follow = undefined;
        }
        if (parts !== undefined) {
            parts.media.pause();
            parts.stage.style.display = `none`;
            parts.bar.style.display = `none`;
        }
    }

    // Hides, and lets the editor know nothing shows, as its own hideMediaControl does: it sends no more updates for a
    // medium it no longer holds.
    private letGo(): void {
        this.hide();
        this.api.mediaData = null;
    }

    // While anything shows, follows the medium as the editor places it now, and lets go once it is gone.
    private keepFollowing(): void {
        if (this.follow !== undefined) {
            return;
        }
        this.follow = this.frame.setInterval(() => {
            const parts = this.parts;
            const data = this.api.getPlayerData?.(`update`) ?? null;
            const moved = !this.onItsSlide() || this.inSlideshow() !== this.shownInSlideshow;
            if (parts === undefined || data?.FrameRect === undefined || data.ControlRect === undefined || moved) {
                this.letGo();
                return;
            }
            this.data = data;
            this.layout(parts, data);
        }, FOLLOW_MS);
    }

    private layout(parts: Parts, data: PlayerData): void {
        const doc = this.frame.document;
        const slideshow = this.inSlideshow();
        // In the fullscreen element during a slideshow: outside it nothing shows.
        const parent: Movable | null = doc.fullscreenElement ?? doc.body;
        if (parent !== null && parts.host.parentElement !== parent) {
            if (parent.moveBefore !== undefined && parts.host.isConnected) {
                parent.moveBefore(parts.host, null);
            } else {
                parent.append(parts.host);
            }
        }
        // While editing, the medium is cut to the editing area, never over the rulers, the thumbnails or the notes.
        const view = slideshow ? null : doc.getElementById(`id_main_view`);
        if (view === null) {
            parts.host.style.clipPath = `none`;
        } else {
            const area = view.getBoundingClientRect();
            const right = this.frame.innerWidth - area.right;
            const bottom = this.frame.innerHeight - area.bottom;
            parts.host.style.clipPath = `inset(${area.top}px ${right}px ${bottom}px ${area.left}px)`;
        }
        const whole: Rect = { X: 0, Y: 0, W: this.frame.innerWidth, H: this.frame.innerHeight };
        const frame = slideshow && data.FullScreen === true && !parts.media.paused ? whole : data.FrameRect;
        if (frame !== undefined) {
            place(parts.stage, frame);
        }
        parts.stage.style.transform = frame === whole ? `none` : transformOf(data);
        if (data.ControlRect !== undefined) {
            place(parts.bar, data.ControlRect);
        }
        parts.bar.dataset[`theme`] = data.Theme === `dark` ? `dark` : `light`;
        this.refresh(parts);
    }

    // The bar and the stage as the medium stands: the picture shows until the video plays, and again once it ends.
    private refresh(parts: Parts): void {
        const media = parts.media;
        const started = !media.paused || (media.currentTime > 0 && !media.ended);
        const video = this.data?.IsVideo !== false;
        parts.stage.style.display = this.data !== undefined && video && started && media.error === null ? `block` : `none`;
        parts.bar.style.display = this.controls ? `flex` : `none`;
        const playing = !media.paused;
        parts.play.replaceChildren(iconOf(this.frame.document, playing ? ICONS.pause : ICONS.play));
        parts.play.setAttribute(`aria-label`, playing ? this.labels.pause : this.labels.play);
        parts.play.title = playing ? this.labels.pause : this.labels.play;
        parts.mute.replaceChildren(iconOf(this.frame.document, media.muted ? ICONS.muted : ICONS.sound));
        parts.mute.setAttribute(`aria-label`, media.muted ? this.labels.unmute : this.labels.mute);
        parts.mute.title = media.muted ? this.labels.unmute : this.labels.mute;
        const duration = Number.isFinite(media.duration) ? media.duration : 0;
        parts.seek.value = duration > 0 ? String(media.currentTime / duration) : `0`;
        parts.time.textContent = `${clockOf(media.currentTime)} / ${clockOf(duration)}`;
    }

    private build(): Parts | undefined {
        if (this.parts !== undefined) {
            return this.parts;
        }
        const doc = this.frame.document;
        if (doc.body === null) {
            return undefined;
        }
        if (doc.getElementById(STYLE_ID) === null) {
            const style = doc.createElement(`style`);
            style.id = STYLE_ID;
            style.textContent = STYLE;
            (doc.head ?? doc.documentElement).append(style);
        }
        const host = doc.createElement(`div`);
        host.id = `oo-media-player`;
        const stage = doc.createElement(`div`);
        stage.className = `stage`;
        const media = doc.createElement(`video`);
        media.playsInline = true;
        media.preload = `metadata`;
        stage.append(media);
        const bar = doc.createElement(`div`);
        bar.className = `bar`;
        const play = doc.createElement(`button`);
        play.type = `button`;
        const time = doc.createElement(`span`);
        time.className = `time`;
        const seek = doc.createElement(`input`);
        seek.type = `range`;
        seek.min = `0`;
        seek.max = `1`;
        seek.step = `any`;
        seek.setAttribute(`aria-label`, this.labels.seek);
        const mute = doc.createElement(`button`);
        mute.type = `button`;
        bar.append(play, time, seek, mute);
        host.append(stage, bar);
        doc.body.append(host);
        const parts: Parts = { host, stage, media, bar, play, time, seek, mute };
        for (const event of KEPT_EVENTS) {
            bar.addEventListener(event, (kept) => kept.stopPropagation());
        }
        play.addEventListener(`click`, () => this.toggle(parts));
        mute.addEventListener(`click`, () => {
            media.muted = !media.muted;
        });
        seek.addEventListener(`input`, () => {
            if (Number.isFinite(media.duration)) {
                media.currentTime = Number(seek.value) * media.duration;
            }
        });
        for (const event of [`play`, `pause`, `timeupdate`, `durationchange`, `volumechange`, `ended`, `seeked`]) {
            media.addEventListener(event, () => this.refresh(parts));
        }
        media.addEventListener(`error`, () => this.unplayable(parts));
        // Leaving the slideshow's fullscreen ends what it played, at once rather than at the next look.
        doc.addEventListener(`fullscreenchange`, () => {
            if (doc.fullscreenElement === null && this.shownInSlideshow) {
                this.letGo();
            }
        });
        this.parts = parts;
        return parts;
    }
}

const place = (element: HTMLElement, rect: Rect): void => {
    element.style.left = `${rect.X}px`;
    element.style.top = `${rect.Y}px`;
    element.style.width = `${rect.W}px`;
    element.style.height = `${rect.H}px`;
};

// The presentation APIs this plays for.
const playing = new WeakSet<object>();

// Plays the presentation editor's audio and video in this browser. True once in place, or for an editor that is not a
// presentation's.
export const installMediaPlayer = (frame: Window, hooks: PlayerHooks): boolean => {
    // SAFETY: the frame's globals are the vendor's; PlayerWindow declares every member read here as optional.
    const win = frame as Window & PlayerWindow;
    const api = win.Asc?.editor;
    const urls = win.AscCommon?.g_oDocumentUrls;
    if (api === undefined || urls === undefined) {
        return false;
    }
    if (api.WordControl?.GetMediaPlayerData === undefined || api.getPlayerData === undefined || playing.has(api)) {
        return true;
    }
    const player = new MediaPlayer(frame, api, urls, hooks);
    api.callMediaPlayerCommand = function (this: PlayerApi, command: string | null | undefined, data: MediaData | null) {
        this.mediaData = data;
        if (command === null || command === undefined || command === ``) {
            return;
        }
        player.command(command, this.getPlayerData?.(command) ?? null);
    };
    playing.add(api);
    return true;
};
