// SPDX-License-Identifier: AGPL-3.0-only
// Intentic's. ONLYOFFICE inserts audio and video only in its desktop app, whose shell picks the file, keeps it in the
// document's media beside a poster picture and answers the presentation editor's asc_AddVideo and asc_AddAudio. Here
// the page answers them: the reader picks a file, the browser draws its poster, and the editor's own media insert
// (the one the desktop app ends in) places it. x2t then writes it into the presentation as PowerPoint does.
import { MEDIA_FILE_TYPES, MEDIA_LIMIT_MB, type EditorPageConfig, type MediaProblem } from "../../../src/protocol.js";

export type MediaKind = "video" | "audio";

// The file extensions each kind of medium is taken in.
interface MediaFormats {
    readonly video: readonly string[];
    readonly audio: readonly string[];
}

// What each kind takes: formats this browser decodes and PowerPoint plays, so a presentation that plays here plays there.
const MEDIA_EXTENSIONS: MediaFormats = {
    video: [`mp4`, `m4v`, `mov`],
    audio: [`mp3`, `m4a`, `wav`],
};

// x2t pairs a picture with its medium only when the picture's name reads display<N>image..., N a bitmask in which 8
// says "has media", and the medium sits beside it under the same name with its own extension. Any other name is saved
// as a link to a file called maskFile.<ext> that does not exist, and the medium is lost (x2t 9.3, measured 2026-11-23).
export const MEDIA_NAME_PREFIX = `display8image_media`;

// The longest edge of a video's poster: the picture PowerPoint and the editor show until it plays.
const POSTER_MAX_EDGE = 1920;
const POSTER_QUALITY = 0.85;
// Where in a video its poster is taken: a second in, or a tenth of the way through a shorter one.
const POSTER_AT_S = 1;
// How long the browser gets to read a file's first frame (or, for audio, its header) before it counts as unreadable.
const READ_TIMEOUT_MS = 15_000;
// The audio icon's size, drawn and placed.
const AUDIO_ICON_PX = 96;

const LIMIT_BYTES = MEDIA_LIMIT_MB * 1024 * 1024;

// The vendor answers a miss with null or undefined; an empty string means none too.
interface DocumentUrls {
    mediaPrefix?: string;
    addImageUrl: (name: string, url: string) => void;
    getUrl: (path: string) => string | null | undefined;
}

// What the editor's media insert takes: a picture already loaded, its size in pixels, and the medium's name.
interface InsertedPicture {
    src: string;
    Image: { width: number; height: number };
    videoUrl?: string;
    audioUrl?: string;
}

export interface MediaApi {
    asc_AddVideo?: () => void;
    asc_AddAudio?: () => void;
    // Only the presentation editor has it: what tells this guard it is in one.
    asc_AddVideoCallback?: unknown;
    ImageLoader?: {
        LoadImagesWithCallback?: (urls: string[], done: () => void) => void;
        LoadImage?: (url: string, kind: number) => { Image?: unknown } | null | undefined;
    };
    WordControl?: { m_oLogicDocument?: { addImages?: (pictures: InsertedPicture[]) => void } };
}

export interface MediaWindow {
    URL: typeof URL;
    Blob: typeof Blob;
    Asc?: { editor?: MediaApi };
    AscCommon?: { g_oDocumentUrls?: DocumentUrls };
}

// A width and height in pixels.
export interface PixelSize {
    readonly width: number;
    readonly height: number;
}

// Whether the presentation editor offers Insert > Audio and Video: an editable presentation whose media x2t writes back.
export const insertsMedia = (config: Pick<EditorPageConfig, "documentType" | "mode" | "saveable" | "fileType">): boolean =>
    config.documentType === `slide` && config.mode === `edit` && config.saveable && MEDIA_FILE_TYPES.includes(config.fileType.toLowerCase());

// A file's extension, lower case; empty for a name without one.
export const extensionOf = (name: string): string => {
    const dot = name.lastIndexOf(`.`);
    return dot <= 0 ? `` : name.slice(dot + 1).toLowerCase();
};

// Why a picked file is refused before anything reads it, or undefined for one worth reading.
export const refusalOf = (kind: MediaKind, file: { readonly name: string; readonly size: number }): MediaProblem | undefined => {
    if (!MEDIA_EXTENSIONS[kind].includes(extensionOf(file.name))) {
        return `unreadable`;
    }
    return file.size > LIMIT_BYTES ? `too-large` : undefined;
};

// A size scaled down, never up, so its longest edge fits `max`.
export const fitWithin = (width: number, height: number, max: number): PixelSize => {
    const scale = Math.min(1, max / Math.max(width, height, 1));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
};

// A media name no picture or medium of the document holds yet, without its extension.
export const freshMediaBase = (taken: (base: string) => boolean, random: () => string): string => {
    for (;;) {
        const base = `${MEDIA_NAME_PREFIX}_${random()}`;
        if (!taken(base)) {
            return base;
        }
    }
};

const randomPart = (frame: Window): string => {
    // getRandomValues, not randomUUID: the page may be served over plain HTTP, where only the former exists.
    const [value = 0] = frame.crypto.getRandomValues(new Uint32Array(1));
    return value.toString(36);
};

// Resolves once one of `events` fires on `target`, or with "timeout"; the first wins.
const firstOf = (frame: Window, target: EventTarget, events: readonly string[], ms: number): Promise<string> =>
    new Promise((resolve) => {
        const done = (name: string): void => {
            frame.clearTimeout(timer);
            for (const event of events) {
                target.removeEventListener(event, handlers[event] ?? (() => undefined));
            }
            resolve(name);
        };
        const handlers: Record<string, () => void> = Object.fromEntries(events.map((event) => [event, () => done(event)]));
        for (const event of events) {
            target.addEventListener(event, handlers[event] ?? (() => undefined));
        }
        const timer = frame.setTimeout(() => done(`timeout`), ms);
    });

const canvasBlob = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

interface Poster {
    readonly blob: Blob;
    readonly extension: string;
    // The size the medium takes on the slide, in pixels.
    readonly width: number;
    readonly height: number;
}

// A frame of the video as a JPEG, or undefined when this browser cannot decode the video.
const videoPoster = async (frame: Window, url: string): Promise<Poster | undefined> => {
    const video = frame.document.createElement(`video`);
    video.muted = true;
    video.preload = `auto`;
    video.playsInline = true;
    video.src = url;
    try {
        if ((await firstOf(frame, video, [`loadeddata`, `error`], READ_TIMEOUT_MS)) !== `loadeddata` || video.videoWidth === 0) {
            return undefined;
        }
        const at = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(POSTER_AT_S, video.duration / 10) : 0;
        if (at > 0) {
            video.currentTime = at;
            await firstOf(frame, video, [`seeked`, `error`], READ_TIMEOUT_MS);
        }
        const size = fitWithin(video.videoWidth, video.videoHeight, POSTER_MAX_EDGE);
        const canvas = frame.document.createElement(`canvas`);
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext(`2d`);
        if (context === null) {
            return undefined;
        }
        context.drawImage(video, 0, 0, size.width, size.height);
        const blob = await canvasBlob(canvas, `image/jpeg`, POSTER_QUALITY);
        return blob === null ? undefined : { blob, extension: `jpg`, width: video.videoWidth, height: video.videoHeight };
    } finally {
        video.removeAttribute(`src`);
        video.load();
    }
};

// A speaker on a rounded tile, the picture an audio clip shows on its slide, or undefined when this browser cannot
// decode the audio.
const audioPoster = async (frame: Window, url: string): Promise<Poster | undefined> => {
    const audio = frame.document.createElement(`audio`);
    audio.preload = `metadata`;
    audio.src = url;
    try {
        if ((await firstOf(frame, audio, [`loadedmetadata`, `error`], READ_TIMEOUT_MS)) !== `loadedmetadata`) {
            return undefined;
        }
    } finally {
        audio.removeAttribute(`src`);
        audio.load();
    }
    const scale = 2;
    const side = AUDIO_ICON_PX * scale;
    const canvas = frame.document.createElement(`canvas`);
    canvas.width = side;
    canvas.height = side;
    const context = canvas.getContext(`2d`);
    if (context === null) {
        return undefined;
    }
    context.scale(scale, scale);
    context.fillStyle = `#3d4a5c`;
    context.beginPath();
    context.roundRect(4, 4, 88, 88, 16);
    context.fill();
    context.fillStyle = `#ffffff`;
    context.beginPath();
    context.moveTo(24, 38);
    context.lineTo(36, 38);
    context.lineTo(52, 24);
    context.lineTo(52, 72);
    context.lineTo(36, 58);
    context.lineTo(24, 58);
    context.closePath();
    context.fill();
    context.strokeStyle = `#ffffff`;
    context.lineWidth = 5;
    context.lineCap = `round`;
    for (const radius of [12, 22]) {
        context.beginPath();
        context.arc(54, 48, radius, -Math.PI / 4, Math.PI / 4);
        context.stroke();
    }
    const blob = await canvasBlob(canvas, `image/png`);
    return blob === null ? undefined : { blob, extension: `png`, width: AUDIO_ICON_PX, height: AUDIO_ICON_PX };
};

// Loads `url` into the editor's image cache, then answers whether it holds a picture.
const loadPicture = (api: MediaApi, url: string): Promise<boolean> =>
    new Promise((resolve) => {
        const loader = api.ImageLoader;
        if (loader?.LoadImagesWithCallback === undefined || loader.LoadImage === undefined) {
            resolve(false);
            return;
        }
        loader.LoadImagesWithCallback([url], () => resolve(loader.LoadImage?.(url, 1)?.Image !== undefined));
    });

// Embeds `file` on the current slide: the medium and its poster registered under one media name, the way x2t pairs
// them, then the editor's own media insert at the medium's own size. Answers why it could not, or undefined.
export const insertMedia = async (frame: Window, kind: MediaKind, file: File): Promise<MediaProblem | undefined> => {
    // SAFETY: the frame's globals are the vendor's; MediaWindow declares every member read here as optional.
    const win = frame as Window & MediaWindow;
    const api = win.Asc?.editor;
    const urls = win.AscCommon?.g_oDocumentUrls;
    const logic = api?.WordControl?.m_oLogicDocument;
    const refused = refusalOf(kind, file);
    if (refused !== undefined || api === undefined || urls === undefined || logic?.addImages === undefined) {
        return refused ?? `unreadable`;
    }
    const extension = extensionOf(file.name);
    // Minted in the frame's realm, where the editor holds its media and hands them to x2t when it saves.
    const mediaUrl = win.URL.createObjectURL(new win.Blob([file], { type: file.type }));
    const poster = kind === `video` ? await videoPoster(frame, mediaUrl) : await audioPoster(frame, mediaUrl);
    if (poster === undefined) {
        win.URL.revokeObjectURL(mediaUrl);
        return `unreadable`;
    }
    const posterUrl = win.URL.createObjectURL(poster.blob);
    const media = urls.mediaPrefix ?? `media/`;
    const base = freshMediaBase(
        (candidate) => [poster.extension, extension].some((ext) => (urls.getUrl(`${media}${candidate}.${ext}`) ?? ``) !== ``),
        () => randomPart(frame),
    );
    urls.addImageUrl(`${base}.${poster.extension}`, posterUrl);
    urls.addImageUrl(`${base}.${extension}`, mediaUrl);
    if (!(await loadPicture(api, posterUrl))) {
        return `unreadable`;
    }
    const picture: InsertedPicture = { src: posterUrl, Image: { width: poster.width, height: poster.height } };
    logic.addImages([kind === `video` ? { ...picture, videoUrl: `${base}.${extension}` } : { ...picture, audioUrl: `${base}.${extension}` }]);
    return undefined;
};

// Asks the reader for a file of `kind`. Called from the toolbar's click, so the picker may open.
const pickFile = (frame: Window, kind: MediaKind, picked: (file: File) => void): void => {
    const input = frame.document.createElement(`input`);
    input.type = `file`;
    input.accept = MEDIA_EXTENSIONS[kind].map((ext) => `.${ext}`).join(`,`);
    // In the document while the picker is open: some browsers open none for an input outside it.
    input.hidden = true;
    frame.document.body.append(input);
    input.addEventListener(`cancel`, () => input.remove(), { once: true });
    input.addEventListener(
        `change`,
        () => {
            input.remove();
            const file = input.files?.[0];
            if (file !== undefined) {
                picked(file);
            }
        },
        { once: true },
    );
    input.click();
};

// The presentation APIs whose media buttons this answers.
const answered = new WeakSet<object>();

// Answers the presentation editor's Insert > Video and Audio, which the bundle shows when the page asks for them (its
// MEDIA_INSERT_FLAG). `problem` hears why a picked file was not added. True once in place, or for an editor that is
// not a presentation's.
export const installMediaInsert = (frame: Window, problem: (problem: MediaProblem) => void): boolean => {
    // SAFETY: the frame's globals are the vendor's; MediaWindow declares every member read here as optional.
    const api = (frame as Window & MediaWindow).Asc?.editor;
    if (api === undefined) {
        return false;
    }
    if (api.asc_AddVideoCallback === undefined || answered.has(api)) {
        return true;
    }
    const add = async (kind: MediaKind, file: File): Promise<void> => {
        try {
            const refused = await insertMedia(frame, kind, file);
            if (refused !== undefined) {
                problem(refused);
            }
        } catch (error) {
            console.warn(`[onlyoffice] inserting ${kind} failed:`, error);
            problem(`unreadable`);
        }
    };
    const ask = (kind: MediaKind) => (): void => pickFile(frame, kind, (file) => void add(kind, file));
    api.asc_AddVideo = ask(`video`);
    api.asc_AddAudio = ask(`audio`);
    answered.add(api);
    return true;
};
