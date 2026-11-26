// SPDX-License-Identifier: AGPL-3.0-only
// Intentic's. The presentation editor plays a slide's audio and video only in ONLYOFFICE's desktop app: it describes
// what to show (the medium, where it sits on screen, play or pause) to callMediaPlayerCommand, which hands that to the
// app's native player and does nothing anywhere else. This answers it in the browser: an HTML media element laid over
// the medium's picture, and a control bar where the editor places the desktop app's.
import type { MediaProblem } from "../../../src/protocol.js";
import { clockOf, ICONS, iconOf, type Labels, labelsFor, STYLE, STYLE_ID } from "./media-controls.js";

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

// While the player is showing, how often it asks the editor where the medium is now: the editor says so on scroll and
// zoom, but not when the slideshow moves on or the shape is dragged.
const FOLLOW_MS = 250;
// While a slideshow's new slide comes in, how often it is asked whether its transition is over, and for how many tries
// before its video is left to its play button.
const AUTOPLAY_MS = 100;
const AUTOPLAY_TRIES = 100;

// The vendor's media handle: the picture the medium belongs to, and that picture's slide.
export interface MediaData {
    getDrawing?: () => { parent?: object | null } | null;
}

// A drawing on a slide, as far as finding its video goes: a group holds its own drawings.
export interface SlideDrawing {
    readonly isVideo?: () => boolean;
    readonly getMediaData?: () => MediaData | null;
    readonly spTree?: readonly SlideDrawing[];
}

export interface Slide {
    readonly cSld?: { readonly spTree?: readonly SlideDrawing[] };
}

// The first video on a slide, groups included, in the slide's own order.
export const firstVideoOf = (slide: Slide | undefined): MediaData | undefined => {
    const find = (drawings: readonly SlideDrawing[]): MediaData | undefined => {
        for (const drawing of drawings) {
            const found = drawing.spTree === undefined ? (drawing.isVideo?.() === true ? (drawing.getMediaData?.() ?? undefined) : undefined) : find(drawing.spTree);
            if (found !== undefined) {
                return found;
            }
        }
        return undefined;
    };
    return find(slide?.cSld?.spTree ?? []);
};

export interface PlayerApi {
    mediaData?: MediaData | null;
    callMediaPlayerCommand?: (command: string | null | undefined, data: MediaData | null) => void;
    getPlayerData?: (command: string) => PlayerData | null;
    asc_registerCallback?: (name: string, callback: (...args: unknown[]) => void) => void;
    WordControl?: {
        // Only the presentation editor's has it: what tells this guard it is in one.
        GetMediaPlayerData?: unknown;
        DemonstrationManager?: { Mode?: boolean; SlideNum?: number; Transition?: { IsPlaying?: () => boolean } };
        m_oLogicDocument?: { CurPage?: number; Slides?: readonly Slide[] };
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
    private autoplay: number | undefined;
    // The editor's handle on the medium shown: the editor drops its own when it hides the controls (in a slideshow, as
    // soon as the pointer leaves the medium), and a medium that goes on playing is still followed through this one.
    private held: MediaData | undefined;
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
        if (action.kind === `hide`) {
            this.hideControls();
            return;
        }
        if (data?.FrameRect === undefined || data.ControlRect === undefined) {
            this.hide();
            return;
        }
        // An update follows what shows; it never brings back what was let go, nor carries it out of a slideshow.
        if (command === `update` && (this.data === undefined || this.inSlideshow() !== this.shownInSlideshow)) {
            this.letGo();
            return;
        }
        const parts = this.build();
        // Already playing this medium: a play from the slideshow's timing (a click on the slide) plays on, not over.
        const playingIt = this.isPlaying(data.MediaFile);
        if (parts === undefined || !this.load(parts, data)) {
            this.hide();
            return;
        }
        this.data = data;
        this.held = this.api.mediaData ?? undefined;
        this.slide = this.drawingSlide();
        this.shownInSlideshow = this.inSlideshow();
        switch (action.kind) {
            case `show`:
                this.controls = true;
                break;
            case `play`:
                if (action.from !== undefined && !playingIt) {
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

    private isPlaying(file: string | null | undefined): boolean {
        return this.parts !== undefined && !this.parts.media.paused && this.file !== undefined && file === this.file;
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

    // The editor hiding the controls (the pointer leaving the medium in a slideshow, the medium deselected, the editor
    // losing focus) hides only the bar of a medium that plays, as the desktop app's player does: it plays on until it is
    // paused, its slide is left, or the slideshow ends.
    private hideControls(): void {
        const parts = this.parts;
        if (parts === undefined || this.data === undefined || parts.media.paused) {
            this.hide();
            return;
        }
        this.controls = false;
        this.refresh(parts);
    }

    hide(): void {
        const parts = this.parts;
        this.controls = false;
        this.data = undefined;
        this.held = undefined;
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
            const data = this.placementOf(this.api.mediaData ?? this.held);
            const moved = !this.onItsSlide() || this.inSlideshow() !== this.shownInSlideshow;
            if (parts === undefined || data?.FrameRect === undefined || data.ControlRect === undefined || moved) {
                this.letGo();
                return;
            }
            this.data = data;
            this.layout(parts, data);
        }, FOLLOW_MS);
    }

    // Where the editor places a medium now. Its placement reads only the medium it holds, so another (one it dropped
    // while it plays on, or one about to start) stands in for that one read.
    private placementOf(medium: MediaData | undefined): PlayerData | null {
        const api = this.api;
        const current = api.mediaData;
        if (medium === undefined || medium === current) {
            return api.getPlayerData?.(`update`) ?? null;
        }
        api.mediaData = medium;
        try {
            return api.getPlayerData?.(`update`) ?? null;
        } finally {
            api.mediaData = current;
        }
    }

    // A slideshow moved to a slide: once the slide shows (its transition over, so the editor can place its video), the
    // slide's first video plays, as a video set to start by itself would. One the slide's timing already started plays on.
    slideShown(): void {
        if (this.autoplay !== undefined) {
            this.frame.clearInterval(this.autoplay);
        }
        const target = this.api.WordControl?.DemonstrationManager?.SlideNum;
        if (target === undefined) {
            this.autoplay = undefined;
            return;
        }
        let tries = 0;
        this.autoplay = this.frame.setInterval(() => {
            tries += 1;
            if (tries > AUTOPLAY_TRIES || this.autoplayed(target)) {
                this.frame.clearInterval(this.autoplay);
                this.autoplay = undefined;
            }
        }, AUTOPLAY_MS);
    }

    // One look at the slide a slideshow moved to: true once its video is playing, or there is nothing left to wait for.
    private autoplayed(target: number): boolean {
        const control = this.api.WordControl;
        const demo = control?.DemonstrationManager;
        if (!this.inSlideshow() || demo?.SlideNum !== target) {
            return true;
        }
        if (demo.Transition?.IsPlaying?.() === true) {
            return false;
        }
        const medium = firstVideoOf(control?.m_oLogicDocument?.Slides?.[target]);
        if (medium === undefined) {
            return true;
        }
        const data = this.placementOf(medium);
        if (data?.FrameRect === undefined || data.ControlRect === undefined) {
            return false;
        }
        if (!this.isPlaying(data.MediaFile)) {
            this.api.callMediaPlayerCommand?.(`play`, medium);
        }
        return true;
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
    api.asc_registerCallback?.(`asc_onDemonstrationSlideChanged`, () => player.slideShown());
    playing.add(api);
    return true;
};
