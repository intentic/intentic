// SPDX-License-Identifier: AGPL-3.0-only
// Ported from ranuts/document lib/onlyoffice/guards/{serverless-save,image-pipeline,long-action,series-settings,
// comment-selection,font-loading,bad-image-url}.ts at 1301bb8b (AGPL-3.0); see editor/NOTICE. Changed: what is patched
// is remembered in registries keyed by the vendor object patched, not by flags written onto it, and the user's save goes
// to the page's save controller. Each answers whether it is in place.

type Fn = (...args: unknown[]) => unknown;

// The editor API of one frame, a new object per document: what the API corrections are keyed by.
const savePatched = new WeakSet<object>();
const imagesPatched = new WeakSet<object>();
const longActionsGuarded = new WeakSet<object>();
const seriesGuarded = new WeakSet<object>();
const commentsGuarded = new WeakSet<object>();
const fontsAccelerated = new WeakSet<object>();
const badImageGuarded = new WeakSet<object>();

interface SaveApi {
    autoSaveGap?: number;
    autoSaveGapFast?: number;
    autoSaveGapRealTime?: number;
    asc_setAutoSaveGap?: (gap: number) => void;
    asc_Save?: (isAutoSave?: boolean, isUndoRequest?: boolean) => unknown;
}

// Serverless save semantics. The SDK's co-authoring autosave loop pushes every edit to a document server and, on the
// fake success this build answers, marks the history saved: the Save button and Ctrl+S go dark a second after every
// keystroke and the reader cannot save at all. So the loop is stopped (a gap of 0 makes _autoSave a no-op, pinned
// against the app re-applying the reader's preference), and a save the reader asks for goes to `onUserSave`, the
// page's save controller, which exports and writes the document.
export const installServerlessSaveSemantics = (frame: Window, onUserSave: () => void): boolean => {
    // SAFETY: the frame's globals are the vendor's; SaveApi declares every member used here as optional.
    const api = (frame as Window & { Asc?: { editor?: SaveApi } }).Asc?.editor;
    const original = api?.asc_Save;
    if (api === undefined || original === undefined) {
        return false;
    }
    if (!savePatched.has(api)) {
        api.autoSaveGap = 0;
        api.autoSaveGapFast = 0;
        api.autoSaveGapRealTime = 0;
        api.asc_setAutoSaveGap = function (this: SaveApi) {
            this.autoSaveGap = 0;
        };
        api.asc_Save = function (this: SaveApi, isAutoSave?: boolean, isUndoRequest?: boolean) {
            if (isAutoSave === true) {
                return original.call(this, isAutoSave, isUndoRequest);
            }
            onUserSave();
            return true;
        };
        savePatched.add(api);
    }
    return true;
};

// The vendor answers a miss with null or undefined, and an empty string means none too: every lookup is read for a
// non-empty string, the way the original's truthiness checks read it.
interface DocumentUrls {
    mediaPrefix?: string;
    addImageUrl: (name: string, url: string) => void;
    getLocal: (url: string) => string | null | undefined;
    getUrl: (path: string) => string | null | undefined;
    getUrls: () => Record<string, string> | null | undefined;
    getImageLocal: (url: string) => string | null;
}

interface ImageWindow {
    AscCommon?: { x2t?: object; sendImgUrls?: unknown; g_oDocumentUrls?: DocumentUrls };
    Asc?: { editor?: object };
    editor?: object;
}

interface ConvertRequest {
    medias?: Record<string, string> | null;
}

const named = (value: string | null | undefined): string | undefined => (value === null || value === undefined || value === `` ? undefined : value);

const extensionFromSource = (source: string): string => {
    const dataMime = /^data:image\/([a-z0-9+.-]+)/i.exec(source)?.[1]?.toLowerCase();
    if (dataMime !== undefined) {
        return dataMime === `svg+xml` ? `svg` : dataMime === `jpeg` ? `jpg` : dataMime;
    }
    return /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(source)?.[1]?.toLowerCase() ?? `png`;
};

// Registers an image source as a media name of the document, once; undefined for a source that is not an image.
const mediaRegistry = (urls: DocumentUrls, media: string): ((source: string) => string | undefined) => {
    let sequence = 0;
    return (source) => {
        if (!/^(data:image|blob:|https?:)/i.test(source)) {
            return undefined;
        }
        const existing = named(urls.getLocal(source));
        if (existing !== undefined) {
            return existing;
        }
        let name: string;
        do {
            name = `image_oo${sequence++}.${extensionFromSource(source)}`;
        } while (named(urls.getUrl(media + name)) !== undefined);
        urls.addImageUrl(name, source);
        return media + name;
    };
};

// Serverless image pipeline. The SDK expects a document server to turn pasted or URL-inserted images into registered
// media names; without one nothing registers, the writer embeds the raw data:/blob:/https: source as the image path,
// and x2t blocks the main thread forever resolving it: the save hangs. Three coordinated patches: a getImageLocal that
// registers an unknown source on lookup, a sendImgUrls that registers directly, and a media fallback on convertFromBin,
// since the vendor's save glue passes an empty media map.
export const installServerlessImagePipeline = (frame: Window): boolean => {
    // SAFETY: the frame's globals are the vendor's; ImageWindow declares every member read here as optional.
    const win = frame as Window & ImageWindow;
    const common = win.AscCommon;
    const urls = common?.g_oDocumentUrls;
    const converter = common?.x2t;
    if (common === undefined || urls === undefined || converter === undefined || (win.Asc?.editor ?? win.editor) === undefined) {
        return false;
    }
    if (imagesPatched.has(urls)) {
        return true;
    }
    const media = urls.mediaPrefix ?? `media/`;
    const register = mediaRegistry(urls, media);
    urls.getImageLocal = function (this: DocumentUrls, url: string) {
        const local = named(this.getLocal(url)) ?? register(url);
        if (local === undefined) {
            return null;
        }
        return local.startsWith(media) ? local.slice(media.length) : local;
    };
    common.sendImgUrls = (_api: unknown, images: string[] | undefined, callback: (result: { url: string; path: string }[]) => void) => {
        const answered = (images ?? []).map((source) => {
            const path = register(source);
            return path === undefined ? { url: `error`, path: `error` } : { url: source, path };
        });
        setTimeout(() => callback(answered), 0);
    };
    // SAFETY: x2t_helper's X2TConverter; convertFromBin is read as optional and only wrapped when it is there.
    const prototype = Object.getPrototypeOf(converter) as { convertFromBin?: (request: ConvertRequest | null) => unknown };
    const original = prototype.convertFromBin;
    if (original !== undefined) {
        prototype.convertFromBin = function (this: unknown, request: ConvertRequest | null) {
            const medias = request?.medias;
            if (request !== null && request !== undefined && (medias === undefined || medias === null || Object.keys(medias).length === 0)) {
                const known = Object.entries(urls.getUrls() ?? {}).filter(([key]) => key.startsWith(media));
                if (known.length > 0) {
                    request.medias = Object.fromEntries(known);
                }
            }
            return original.call(this, request);
        };
    }
    imagesPatched.add(urls);
    return true;
};

interface LongActionApi {
    IsLongActionCurrent?: number;
    sync_EndAction?: (type: number, id: number) => void;
    asc_editChartInFrameEditor?: Fn;
    asc_editOleTableInFrameEditor?: Fn;
    asc_runAutostartMacroses?: Fn;
}

// Brings the long-action counter back down to `before`, ending the blocking action the way the app layer expects.
const releaseTo = (target: LongActionApi, before: number, block: number | undefined): void => {
    while (typeof target.IsLongActionCurrent === `number` && target.IsLongActionCurrent > before) {
        if (block !== undefined && target.sync_EndAction !== undefined) {
            target.sync_EndAction(block, 0);
        } else {
            target.IsLongActionCurrent -= 1;
        }
    }
};

// Long-action counter leak. The chart and OLE frame-editor entry points start a blocking action and then, in a
// serverless build with no frame editor to open, throw before ending it: the counter stays raised for the session and
// every export is silently dropped, so the document can never be saved again. Restore the counter on the way out.
export const installLongActionLeakGuard = (frame: Window): boolean => {
    // SAFETY: the frame's globals are the vendor's; LongActionApi declares every member used here as optional.
    const asc = (frame as Window & { Asc?: { editor?: LongActionApi; c_oAscAsyncActionType?: { BlockInteraction?: number } } }).Asc;
    const api = asc?.editor;
    if (api === undefined) {
        return false;
    }
    if (longActionsGuarded.has(api)) {
        return true;
    }
    // Entries that stay "long" until an async callback are released only when they throw; synchronous ones whenever
    // they return with the counter still raised.
    const entries = [
        [`asc_editChartInFrameEditor`, false],
        [`asc_editOleTableInFrameEditor`, false],
        [`asc_runAutostartMacroses`, true],
    ] as const;
    for (const [name, releaseOnReturn] of entries) {
        const original = api[name];
        if (original === undefined) {
            continue;
        }
        api[name] = function (this: LongActionApi, ...args: unknown[]) {
            const before = this.IsLongActionCurrent ?? 0;
            const block = asc?.c_oAscAsyncActionType?.BlockInteraction;
            try {
                const out = original.apply(this, args);
                if (releaseOnReturn) {
                    releaseTo(this, before, block);
                }
                return out;
            } catch (error) {
                releaseTo(this, before, block);
                console.warn(`[onlyoffice] ${name} failed; the long-action counter was restored`, error);
                return undefined;
            }
        };
    }
    longActionsGuarded.add(api);
    return true;
};

interface SheetModel {
    selectionRange?: { getLast?: () => { r1: number; c1: number; r2: number; c2: number } };
    getRowsCount?: () => number;
    getColsCount?: () => number;
}

interface SeriesApi {
    asc_GetSeriesSettings?: () => unknown;
    wb?: { getWorksheet?: () => { setSelection?: (range: unknown) => void; model?: SheetModel | null } | null };
}

type RangeConstructor = new (c1: number, r1: number, c2: number, r2: number) => unknown;

const MAX_SERIES_CELLS = 200_000;

// The selection clamped to the used area and put back after, or undefined to leave the vendor's call as it is; a probe
// that fails leaves it too.
const clampedSelection = (target: SeriesApi, Range: RangeConstructor): { apply: () => void; restore: () => void } | undefined => {
    try {
        const sheet = target.wb?.getWorksheet?.();
        const model = sheet?.model;
        const last = model?.selectionRange?.getLast?.();
        const select = sheet?.setSelection?.bind(sheet);
        if (model === undefined || model === null || last === undefined || select === undefined) {
            return undefined;
        }
        if ((last.r2 - last.r1 + 1) * (last.c2 - last.c1 + 1) <= MAX_SERIES_CELLS) {
            return undefined;
        }
        const rows = Math.max(1, model.getRowsCount?.() ?? 1);
        const cols = Math.max(1, model.getColsCount?.() ?? 1);
        return {
            apply: () => select(new Range(last.c1, last.r1, Math.min(last.c2, cols), Math.min(last.r2, rows))),
            restore: () => select(new Range(last.c1, last.r1, last.c2, last.r2)),
        };
    } catch {
        // allow(silent-catch): any probing failure falls through to the vendor's own behaviour, as the original does.
        return undefined;
    }
};

// Whole-sheet series settings. After select-all, the chart dialog's data source builds series over every cell of the
// 1048576 x 16384 grid until the tab runs out of memory. Oversized selections are clamped to the used area for the call.
export const installSeriesSettingsGuard = (frame: Window): boolean => {
    // SAFETY: the frame's globals are the vendor's; SeriesApi and the Range constructor are read as optional.
    const asc = (frame as Window & { Asc?: { editor?: SeriesApi; Range?: RangeConstructor } }).Asc;
    const api = asc?.editor;
    const Range = asc?.Range;
    const original = api?.asc_GetSeriesSettings;
    if (api === undefined || Range === undefined || original === undefined) {
        return false;
    }
    if (!seriesGuarded.has(api)) {
        api.asc_GetSeriesSettings = function (this: SeriesApi) {
            const clamped = clampedSelection(this, Range);
            if (clamped === undefined) {
                return original.call(this);
            }
            clamped.apply();
            try {
                return original.call(this);
            } finally {
                clamped.restore();
            }
        };
        seriesGuarded.add(api);
    }
    return true;
};

// The vendor's own name for a sheet's current selection.
const SELECTION = `_getSelection`;

interface CommentApi {
    asc_RemoveAllComments?: Fn;
    asc_ResolveAllComments?: Fn;
    wb?: { getWorksheet?: () => Partial<Record<typeof SELECTION, () => unknown>> | null };
}

// Comment bulk actions on an empty selection. "Remove comments in the current selection" reads a selection that is null
// until the grid was focused once, and throws after opening a history transaction it then never closes.
export const installCommentSelectionGuard = (frame: Window): boolean => {
    // SAFETY: the frame's globals are the vendor's; CommentApi declares every member used here as optional.
    const api = (frame as Window & { Asc?: { editor?: CommentApi } }).Asc?.editor;
    if (api?.asc_RemoveAllComments === undefined) {
        return false;
    }
    if (commentsGuarded.has(api)) {
        return true;
    }
    for (const name of [`asc_RemoveAllComments`, `asc_ResolveAllComments`] as const) {
        const original = api[name];
        if (original === undefined) {
            continue;
        }
        api[name] = function (this: CommentApi, ...args: unknown[]) {
            // (onlyMine, currentSelectionOnly, ...): removing comments from an empty selection is a no-op anyway.
            if (args[1] && !this.wb?.getWorksheet?.()?.[SELECTION]?.()) {
                return undefined;
            }
            return original.apply(this, args);
        };
    }
    commentsGuarded.add(api);
    return true;
};

interface FontInfo {
    indexR: number;
    indexI: number;
    indexB: number;
    indexBI: number;
    needR?: boolean;
    needI?: boolean;
    needB?: boolean;
    needBI?: boolean;
    NeedStyles?: number;
}

interface FontLoader {
    fonts_loading?: FontInfo[];
    fontFiles?: { CheckLoaded: () => boolean; LoadFontAsync: (path: string, cb: unknown) => unknown }[];
    fontFilesPath?: string;
    LoadDocumentFonts?: Fn;
    LoadDocumentFonts2?: Fn;
}

// Starts every still-unloaded face of every queued family at once; the loader's own serial poll then finds each one in
// flight or done.
const prefetchQueued = (loader: FontLoader): void => {
    const files = loader.fontFiles;
    const path = loader.fontFilesPath;
    if (files === undefined || path === undefined) {
        return;
    }
    for (const info of loader.fonts_loading ?? []) {
        const all = info.NeedStyles === undefined || (info.NeedStyles & 15) === 15;
        const faces: [boolean | undefined, number][] = [
            [all || info.needR, info.indexR],
            [all || info.needI, info.indexI],
            [all || info.needB, info.indexB],
            [all || info.needBI, info.indexBI],
        ];
        for (const [needed, index] of faces) {
            const file = needed && index >= 0 ? files[index] : undefined;
            if (file !== undefined && !file.CheckLoaded()) {
                // Idempotent per file: it returns early once a fetch is in flight.
                file.LoadFontAsync(path, null);
            }
        }
    }
};

// Font-load acceleration. The SDK loads a document's font families one at a time, a round trip each; this starts every
// queued face at once, and skips the preload of default faces the document may never use.
export const installFontLoadAcceleration = (frame: Window): boolean => {
    // SAFETY: the frame's globals are the vendor's; the loader and its members are read as optional.
    const api = (frame as Window & { Asc?: { editor?: { IsNeedDefaultFonts?: () => boolean; FontLoader?: FontLoader } } }).Asc?.editor;
    const loader = api?.FontLoader;
    if (api === undefined || loader?.LoadDocumentFonts === undefined) {
        return false;
    }
    if (fontsAccelerated.has(api)) {
        return true;
    }
    api.IsNeedDefaultFonts = () => false;
    for (const name of [`LoadDocumentFonts`, `LoadDocumentFonts2`] as const) {
        const original = loader[name];
        if (original === undefined) {
            continue;
        }
        loader[name] = function (this: FontLoader, ...args: unknown[]) {
            const out = original.apply(this, args);
            try {
                prefetchQueued(loader);
            } catch {
                // allow(silent-catch): acceleration is best effort; the vendor's serial path still loads every face.
            }
            return out;
        };
    }
    fontsAccelerated.add(api);
    return true;
};

// The literal the offline build's Offline controller assigns over the translated `errorBadImageUrl`, telling every
// reader in Chinese to configure an image proxy they cannot reach.
const OFFLINE_BAD_IMAGE_URL = `无法加载图片：地址无效或目标站不允许跨域访问（可通过 editorConfig.imageProxy 配置图片代理）`;

interface MainController {
    errorBadImageUrl?: string;
}

// What a controller set for the message other than that literal, by controller.
const badImageMessages = new WeakMap<MainController, string>();

interface EditorNamespace {
    Controllers?: { Main?: { prototype?: MainController } };
    getController?: (name: string) => (MainController & Record<string, unknown>) | undefined;
}

// Keeps one namespace's translated message: an accessor on the prototype swallows exactly the hardcoded assignment and
// lets every other write through; answers whether it could (the locale merge may not have landed yet).
const guardBadImageUrl = (namespace: EditorNamespace): boolean => {
    const prototype = namespace.Controllers?.Main?.prototype;
    const localized = prototype?.errorBadImageUrl;
    if (prototype === undefined || localized === undefined || localized === ``) {
        return false;
    }
    if (badImageGuarded.has(prototype)) {
        return true;
    }
    Object.defineProperty(prototype, `errorBadImageUrl`, {
        configurable: true,
        get(this: MainController) {
            return badImageMessages.get(this) ?? localized;
        },
        set(this: MainController, value: string) {
            if (value !== OFFLINE_BAD_IMAGE_URL) {
                badImageMessages.set(this, value);
            }
        },
    });
    badImageGuarded.add(prototype);
    // loadDocument may already have run and left its own copy on the instance.
    const controller = namespace.getController?.(`Main`);
    if (controller !== undefined && Object.hasOwn(controller, `errorBadImageUrl`) && controller[`errorBadImageUrl`] === OFFLINE_BAD_IMAGE_URL) {
        delete controller[`errorBadImageUrl`];
    }
    return true;
};

// Keeps the translated "image URL is incorrect" message in every editor namespace the frame has.
export const installBadImageUrlGuard = (frame: Window): boolean => {
    // SAFETY: the frame's globals are the vendor's; each app namespace is read as optional, and exactly one exists.
    const win = frame as Window & Partial<Record<`DE` | `SSE` | `PE` | `PDFE`, EditorNamespace>>;
    const guarded = [win.DE, win.SSE, win.PE, win.PDFE].flatMap((namespace) => (namespace === undefined ? [] : [guardBadImageUrl(namespace)]));
    return guarded.includes(true);
};
