// SPDX-License-Identifier: AGPL-3.0-only
// Ported from ranuts/document lib/onlyoffice/guards/x2t-worker.ts at 1301bb8b (AGPL-3.0); see editor/NOTICE. Changed:
// the worker is found beside the frame's own sdkjs rather than at the site root, since the bundle is served under a path,
// and the converters already proxied are remembered here rather than flagged on the converter.
import { waitForFontSystem, type FontSystemWindow } from "./font-system.js";

// x2t converts in a worker, so its heap is something the browser gets back. It declares a 283 MB initial heap and holds
// ~340 MB after an open; in the editor frame that stays resident for the frame's life. The offline build routes every
// conversion through two methods of one object (AscCommon.x2t.convertToBin on open, convertFromBin on save), so this
// replaces those two with a proxy over a worker running the same x2t_helper.js, terminated once idle. The document and
// media cross as bytes; fonts cross as a list of URLs, which the worker fetches from the same HTTP cache.

const IDLE_TERMINATE_MS = 30_000;

// Where the worker is, from the editor frame's document (web-apps/apps/<app>/main/index.html): the same climb the
// vendor's own x2t_helper makes to reach sdkjs.
const WORKER_FROM_FRAME = `../../../../sdkjs/common/wasm/x2t/x2t.worker.js`;

const FONT_STYLE_SUFFIX = { indexR: ``, indexB: `_Bold`, indexBI: `_Bold_Italic`, indexI: `_Italic` } as const;

interface FontSource {
    readonly fileName: string;
    readonly url: string;
}

interface MediaPayload {
    readonly bytes: Uint8Array;
    readonly mime: string;
}

interface Converter {
    convertToBin?: (data: unknown, fileName?: string, fileExt?: string) => Promise<unknown>;
    convertFromBin?: (request: Record<string, unknown>) => Promise<unknown>;
}

type FrameScope = Window & {
    AscCommon?: { x2t?: Converter; g_font_loader?: { fontFilesPath?: string; fontFiles?: ({ Id?: string | null } | undefined)[] } };
    AscFonts?: { g_font_infos?: (Record<string, unknown> | null | undefined)[] };
    Worker?: typeof Worker;
};

// The converters whose two methods now go to a worker (or were left alone for want of one).
const proxied = new WeakSet<object>();

interface Pending {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
}

// One worker per frame, made on demand and dropped when it goes quiet.
class WorkerChannel {
    private worker: Worker | undefined;
    private readonly pending = new Map<number, Pending>();
    private nextId = 1;
    private idleTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly win: FrameScope) {}

    // Nothing is transferred on the way in: `convertFromBin` is handed the editor's live Editor.bin, and a transfer would
    // detach it in the frame. The worker transfers its results back; those buffers are its own.
    send(op: string, payload: Record<string, unknown>, fonts: FontSource[]): Promise<unknown> {
        const worker = this.start();
        clearTimeout(this.idleTimer);
        const id = this.nextId++;
        return new Promise<unknown>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            // No transfer list, for the reason above.
            worker.postMessage({ id, op, payload, fonts }, []);
        });
    }

    private start(): Worker {
        if (this.worker !== undefined) {
            return this.worker;
        }
        const WorkerCtor = this.win.Worker;
        if (WorkerCtor === undefined) {
            throw new Error(`X2T worker unavailable: this engine has no Worker`);
        }
        // Built through the frame's own Worker, so the realm dies with the frame even if nothing terminates it first.
        const worker = new WorkerCtor(new URL(WORKER_FROM_FRAME, this.win.location.href).href);
        worker.addEventListener(`message`, (event: MessageEvent<{ id?: number; ok?: boolean; result?: unknown; error?: string } | null>) => {
            const { id, ok, result, error } = event.data ?? {};
            const waiting = id === undefined ? undefined : this.pending.get(id);
            if (id === undefined || waiting === undefined) {
                return;
            }
            this.pending.delete(id);
            if (ok === true) {
                waiting.resolve(result);
            } else {
                waiting.reject(new Error(error === undefined || error === `` ? `X2T worker conversion failed` : error));
            }
            this.scheduleIdleTermination();
        });
        // A worker that died takes every request in flight with it; leaving them pending is a spinner that never stops.
        worker.addEventListener(`error`, (event: ErrorEvent) => {
            const failure = new Error(`X2T module failed to instantiate: ${event.message === `` ? `worker error` : event.message}`);
            for (const waiting of this.pending.values()) {
                waiting.reject(failure);
            }
            this.pending.clear();
            this.terminate();
        });
        this.worker = worker;
        return worker;
    }

    private scheduleIdleTermination(): void {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            if (this.pending.size === 0) {
                this.terminate();
            }
        }, IDLE_TERMINATE_MS);
    }

    private terminate(): void {
        clearTimeout(this.idleTimer);
        this.worker?.terminate();
        this.worker = undefined;
    }
}

// The faces the open document needs, as URLs: the same fields the vendor's fetchFonts walks, read only once the font
// system is up, since a half-built one here does not throw but silently yields a document with no fonts.
const fontSources = async (win: FrameScope): Promise<FontSource[]> => {
    // The same frame, read as the font system's own view of it: FrameScope's font fields are a subset of FontSystemWindow's.
    const fonts: FontSystemWindow = win;
    await waitForFontSystem(fonts);
    const infos = win.AscFonts?.g_font_infos;
    const loader = win.AscCommon?.g_font_loader;
    const files = loader?.fontFiles;
    if (infos === undefined || files === undefined) {
        return [];
    }
    // `fontFilesPath` is relative to the editor frame's document; the worker would resolve it against its own.
    const base = loader?.fontFilesPath ?? ``;
    const sources: FontSource[] = [];
    for (const info of infos) {
        // Entries can be holes, and a face with no styles needed is not fetched: the vendor's own walk skips both.
        if (info === undefined || info === null || !info[`NeedStyles`]) {
            continue;
        }
        for (const [field, suffix] of Object.entries(FONT_STYLE_SUFFIX)) {
            const index = info[field];
            const id = typeof index === `number` && index !== -1 ? files[index]?.Id : undefined;
            if (id !== undefined && id !== null && id !== ``) {
                sources.push({ fileName: `${String(info[`Name`])}${suffix}.ttf`, url: new URL(base + id, win.location.href).href });
            }
        }
    }
    return sources;
};

// The string forms the vendor's x2t_helper treats as somewhere to fetch from; any other string is data it encodes.
const looksLikeUrl = (value: string): boolean => /^(data|blob|file|https?):/i.test(value.trim()) || URL.canParse(value);

// Anything the vendor hands over (a URL string, a Blob, a typed array) as bytes. Never `instanceof`: the values come
// from the editor frame's realm, where a perfectly good Uint8Array is not an instance of this page's.
const toBytes = async (value: unknown): Promise<Uint8Array | undefined> => {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value === `string`) {
        if (!looksLikeUrl(value)) {
            return undefined;
        }
        const response = await fetch(value);
        if (!response.ok) {
            throw new Error(`Failed to read document data (${response.status})`);
        }
        return new Uint8Array(await response.arrayBuffer());
    }
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    const tag = Object.prototype.toString.call(value);
    if (tag === `[object ArrayBuffer]`) {
        // SAFETY: its internal tag says ArrayBuffer, which holds across realms where instanceof does not.
        return new Uint8Array(value as ArrayBuffer);
    }
    // SAFETY: its internal tag says Blob or File, which holds across realms where instanceof does not.
    return tag === `[object Blob]` || tag === `[object File]` ? new Uint8Array(await (value as Blob).arrayBuffer()) : undefined;
};

const mediaToBytes = async (medias: unknown): Promise<Record<string, unknown>> => {
    if (typeof medias !== `object` || medias === null) {
        return {};
    }
    const entries: [string, unknown][] = [];
    // SAFETY: an object, as checked above: x2t_helper's media map of path to source.
    for (const [path, url] of Object.entries(medias as Record<string, unknown>)) {
        try {
            const bytes = await toBytes(url);
            // Forms this cannot resolve cross as they came, for the vendor's own reading; nothing crosses as nothing.
            if (bytes !== undefined) {
                entries.push([path, bytes]);
            } else if (url !== undefined && url !== null) {
                entries.push([path, url]);
            }
        } catch {
            // allow(silent-catch): a medium that cannot be read is one the conversion does without, as it did in the frame.
        }
    }
    return Object.fromEntries(entries);
};

// The worker's media bytes as the blob URLs the editor holds.
const mintMediaUrls = (media: unknown): Record<string, string> => {
    if (typeof media !== `object` || media === null) {
        return {};
    }
    // SAFETY: an object, as checked above: the worker's media map of path to bytes and type.
    const payloads = Object.entries(media as Record<string, MediaPayload | undefined>);
    return Object.fromEntries(
        payloads.flatMap(([path, value]) => {
            if (value?.bytes === undefined) {
                return [];
            }
            const type = value.mime === undefined || value.mime === `` ? `application/octet-stream` : value.mime;
            // SAFETY: bytes the worker transferred back; a Uint8Array is a BlobPart.
            return [[path, URL.createObjectURL(new Blob([value.bytes as BlobPart], { type }))]];
        }),
    );
};

// The worker's answer to a conversion, with its media turned back into blob URLs the editor can hold.
const withMedia = (result: unknown): Record<string, unknown> => {
    // SAFETY: the worker answers x2t_helper's own result object; only its `media` is read, the rest passes through.
    const answered = result as Record<string, unknown>;
    return { ...answered, media: mintMediaUrls(answered[`media`]) };
};

export const installX2tWorkerProxy = (frame: Window): boolean => {
    // SAFETY: the frame's globals are the vendor's; FrameScope declares every member read here as optional.
    const win = frame as FrameScope;
    const converter = win.AscCommon?.x2t;
    // x2t_helper.js lands during the editor's boot; "not yet" keeps the caller re-applying until it does.
    if (converter?.convertToBin === undefined) {
        return false;
    }
    // Already proxied, or no Worker in this engine: the in-frame path is still correct, just heavier.
    if (proxied.has(converter) || win.Worker === undefined) {
        proxied.add(converter);
        return true;
    }
    const channel = new WorkerChannel(win);
    converter.convertToBin = async (data: unknown, fileName?: string, fileExt?: string) => {
        if (data === undefined || data === null) {
            throw new Error(`Document conversion failed: nothing to convert`);
        }
        const payload = (await toBytes(data)) ?? data;
        return withMedia(await channel.send(`convertToBin`, { data: payload, fileName, fileExt }, await fontSources(win)));
    };
    converter.convertFromBin = async (request: Record<string, unknown>) => {
        const binary = (await toBytes(request[`binary`])) ?? request[`binary`];
        const medias = await mediaToBytes(request[`medias`]);
        return withMedia(await channel.send(`convertFromBin`, { request: { ...request, binary, medias } }, await fontSources(win)));
    };
    proxied.add(converter);
    return true;
};
