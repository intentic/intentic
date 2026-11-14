import {
    WEBEXT_MEDIA_MAX_BYTES,
    WEBEXT_MEDIA_NAME_HEADER,
    WEBEXT_MEDIA_SOURCE_HEADER,
    WebExtMediaAnswerSchema,
    webextMediaUrl,
} from "@intentic/sandbox-contract/webext";
import { dropStaged, readStaged, stageMedia } from "../../page/media-driver.js";
import { originPattern, RefusedError } from "../policy.js";
import { type SandboxKey, store } from "../store.js";
import { inject } from "./page.js";
import { type TargetTab, targetTab } from "./tab-access.js";

// A picture, video or file from a page in the person's browser, put into the sandbox: `save_media` (media-tools.ts), a
// download the agent's own click started (media-downloads.ts) and the ChatGPT kit (kits/) all come through here.
//
// How the bytes travel. The page fetches the file itself, in the isolated world, so its own cookies and its blob:
// addresses (which exist only inside that page) work as they do for the page. The file stays in the page while the
// worker reads it out in 4 MB base64 slices, one executeScript per slice: one call's answer cannot carry tens of MB,
// and base64 is what crosses that boundary. Only when the page's own fetch fails outright (another site that refuses
// pages from elsewhere) does the worker fetch it, and then only from a site the agent is allowed on, where the
// extension holds the browser's permission and so the person's cookies. The worker then POSTs the raw bytes to the
// sandbox's /system/webext/media on its own token, never inside a tool answer, and the sandbox answers where the file
// now is. The cap is the contract's WEBEXT_MEDIA_MAX_BYTES (50 MB), held here and again by the sandbox.

export interface SavedMedia {
    // Where the file now is in the sandbox, as the agent will read it.
    readonly path: string;
    readonly bytes: number;
    readonly mimeType: string;
}

// One slice out of the page per call: 4 MB is 5.3 MB of base64, well inside what one call's answer carries.
const SLICE_BYTES = 4 * 1024 * 1024;

export const megabytes = (bytes: number): string =>
    bytes < 1024 ? `${bytes} bytes` : bytes < 1_048_576 ? `${Math.round(bytes / 1024)} kB` : `${(bytes / 1_048_576).toFixed(1)} MB`;

const TOO_LARGE = `That file is larger than the ${WEBEXT_MEDIA_MAX_BYTES / 1_048_576} MB one save carries, so nothing was saved.`;

const fromBase64 = (data: string): Uint8Array<ArrayBuffer> => {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) {
        bytes[at] = binary.charCodeAt(at);
    }
    return bytes;
};

export const toBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    for (let at = 0; at < bytes.length; at += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return btoa(binary);
};

/* WHAT THE BYTES ARE. */

const ascii = (bytes: Uint8Array, from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));
const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean => signature.every((value, at) => bytes[at] === value);

// What a file's first bytes say it is, for the formats a page hands out as media or files; undefined for anything
// else. `text/html` is here only so a sign-in page answering in place of a picture can be told apart.
export const sniffType = (head: Uint8Array): string | undefined => {
    const riff = ascii(head, 0, 4) === "RIFF" ? ascii(head, 8, 12) : undefined;
    const brand = ascii(head, 4, 8) === "ftyp" ? ascii(head, 8, 12) : undefined;
    const signatures: readonly (readonly [boolean, string])[] = [
        [startsWith(head, [0x89, 0x50, 0x4e, 0x47]), "image/png"],
        [startsWith(head, [0xff, 0xd8, 0xff]), "image/jpeg"],
        [ascii(head, 0, 4) === "GIF8", "image/gif"],
        [riff === "WEBP", "image/webp"],
        [riff === "WAVE", "audio/wav"],
        [brand === "avif" || brand === "avis", "image/avif"],
        [brand !== undefined && ["heic", "heix", "mif1", "msf1"].includes(brand), "image/heic"],
        [brand === "qt  ", "video/quicktime"],
        [brand === "M4A ", "audio/mp4"],
        [brand !== undefined, "video/mp4"],
        [startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]), "video/webm"],
        [ascii(head, 0, 4) === "OggS", "audio/ogg"],
        [ascii(head, 0, 4) === "fLaC", "audio/flac"],
        [ascii(head, 0, 3) === "ID3" || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0), "audio/mpeg"],
        [ascii(head, 0, 5) === "%PDF-", "application/pdf"],
        [startsWith(head, [0x50, 0x4b, 0x03, 0x04]), "application/zip"],
        [startsWith(head, [0, 0, 1, 0]), "image/x-icon"],
    ];
    const known = signatures.find(([matches]) => matches)?.[1];
    if (known !== undefined) {
        return known;
    }
    const text = ascii(head, 0, Math.min(head.length, 512)).replace(/^\uFEFF/u, "").trimStart().toLowerCase();
    if (text.startsWith("<!doctype html") || text.startsWith("<html") || text.startsWith("<head")) {
        return "text/html";
    }
    return text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg")) ? "image/svg+xml" : undefined;
};

// Every type sniffType can name: one of these claimed by a file whose bytes say otherwise is not that file.
const SNIFFABLE = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/heic",
    "image/svg+xml",
    "image/x-icon",
    "video/mp4",
    "video/quicktime",
    "video/webm",
    "audio/wav",
    "audio/mp4",
    "audio/ogg",
    "audio/flac",
    "audio/mpeg",
    "application/pdf",
    "application/zip",
]);

// Sound and video share containers (an .ogg or .mp4 is either), so they are one family when a claim is checked.
const family = (type: string): string => {
    const top = type.split("/")[0] ?? "";
    return top === "audio" || top === "video" ? "av" : top;
};

// The type a file is stored as: what its bytes say when they say anything, checked against what the page claimed. A web
// page where a file was expected (a sign-in page, an expired link) is refused, and so is a claim the bytes contradict:
// what lands in the sandbox is what the agent was told it is.
export const verifiedType = (head: Uint8Array, claimed: string): string => {
    const claim = (claimed.split(";")[0] ?? "").trim().toLowerCase();
    const sniffed = sniffType(head);
    if (sniffed === "text/html" || (sniffed === undefined && claim === "text/html")) {
        throw new RefusedError(
            `That address answered with a web page, not a file: usually a sign-in page or a link that has expired. Take a fresh snapshot and save the picture by its ref, or open the page and look.`,
        );
    }
    const media = ["image", "av"].includes(family(claim));
    if (sniffed !== undefined) {
        if (media && family(claim) !== family(sniffed)) {
            throw new RefusedError(`That address said it holds ${claim}, but its bytes are ${sniffed}, so nothing was saved.`);
        }
        return sniffed;
    }
    if (SNIFFABLE.has(claim)) {
        throw new RefusedError(`That address said it holds ${claim}, but its bytes are not one, so nothing was saved.`);
    }
    return claim === "" ? "application/octet-stream" : claim;
};

/* WHAT AN ADDRESS MAY BRING IN. */

// Documents and archives a site hands out as files, kept from a bare address beside pictures, video and sound. Office
// and OpenDocument formats are matched by prefix below.
const FILE_TYPES = new Set([
    "application/pdf",
    "application/zip",
    "application/x-zip-compressed",
    "application/gzip",
    "application/x-gzip",
    "application/x-tar",
    "application/x-bzip2",
    "application/x-xz",
    "application/x-7z-compressed",
    "application/vnd.rar",
    "application/x-rar-compressed",
    "application/epub+zip",
    "application/rtf",
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
]);
const FILE_TYPE_PREFIXES = ["application/vnd.openxmlformats-officedocument.", "application/vnd.oasis.opendocument."];

// Whether a file fetched from an address the agent gave (not one the page itself pointed at) may be kept. That address
// is fetched with the site's own sign-in, so it could as well be one of the site's own API answers (an account, a chat
// history) as a picture: only media, a listed document or archive, or a file the site serves as a download (an
// attachment) comes in. JSON, text and anything else unlisted stays out. Throws the agent's sentence when refused.
export const keptFromAddress = (mimeType: string, attachment: boolean): void => {
    const top = mimeType.split("/")[0] ?? "";
    if (attachment || ["image", "video", "audio"].includes(top) || FILE_TYPES.has(mimeType) || FILE_TYPE_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) {
        return;
    }
    throw new RefusedError(
        `That address answered with ${mimeType}, not a picture, video, sound, document, archive or download, so nothing was saved: save_media by url keeps only those, since the address is fetched with the site's own sign-in. To keep something the page shows, aim at it by its ref from a snapshot; to read a page's words, use read.`,
    );
};

/* GETTING THE BYTES. */

interface Fetched {
    readonly data: Uint8Array<ArrayBuffer>;
    readonly claimed: string;
    // The site served it as a download (Content-Disposition: attachment).
    readonly attachment: boolean;
}

const isAttachment = (response: Response): boolean => /^\s*attachment/iu.test(response.headers.get("content-disposition") ?? "");

// A response's body, refused past the cap as it arrives rather than after it is all in memory.
const cappedBody = async (response: Response): Promise<Uint8Array<ArrayBuffer>> => {
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > WEBEXT_MEDIA_MAX_BYTES) {
        throw new RefusedError(TOO_LARGE);
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const read = reader === undefined ? { done: true as const } : await reader.read();
        if (read.done) {
            break;
        }
        size += read.value.byteLength;
        if (size > WEBEXT_MEDIA_MAX_BYTES) {
            // allow(silent-catch): the save is refused either way; a cancel that fails has nothing left to stop
            await reader?.cancel().catch(() => undefined);
            throw new RefusedError(TOO_LARGE);
        }
        chunks.push(read.value);
    }
    const data = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
        data.set(chunk, at);
        at += chunk.byteLength;
    }
    return data;
};

// A data: address carries its own bytes, so no page is asked.
const fromDataUrl = async (url: string): Promise<Fetched> => {
    if (url.length * 0.75 > WEBEXT_MEDIA_MAX_BYTES) {
        throw new RefusedError(TOO_LARGE);
    }
    // allow(silent-catch): a data: address that does not decode is refused as one
    const response = await fetch(url).catch(() => undefined);
    if (response === undefined) {
        throw new RefusedError(`That data: address does not decode, so nothing was saved.`);
    }
    return { data: await cappedBody(response), claimed: response.headers.get("content-type") ?? "", attachment: false };
};

// The file the page holds under `slot`, read out a slice at a time.
const readOut = async (tabId: number, slot: string, bytes: number): Promise<Uint8Array<ArrayBuffer>> => {
    const data = new Uint8Array(bytes);
    for (let offset = 0; offset < bytes; offset += SLICE_BYTES) {
        const slice = await inject(tabId, readStaged, [slot, offset, SLICE_BYTES]);
        if (!slice.ok) {
            throw new RefusedError(`The page let go of the file while it was being read (it may have navigated). Try again.`);
        }
        data.set(fromBase64(slice.data), offset);
    }
    return data;
};

// The worker's own fetch, for a file the page could not fetch (another site that refuses pages from elsewhere). Only
// from a site the agent is allowed on, where the browser's permission lets this extension send the person's cookies:
// any other site is the person's to allow first.
const fromWorker = async (url: string, why: string): Promise<Fetched> => {
    const pattern = originPattern(url);
    const host = new URL(url).host;
    const allowed = pattern !== undefined && pattern in (await store.modes()) && (await chrome.permissions.contains({ origins: [pattern] }));
    if (!allowed) {
        throw new RefusedError(
            `The page could not fetch that file (${why}): it is served from ${host}, another site, which turns away requests from this page. This browser can fetch it itself only from a site you are allowed on, so ask_access for ${host}, then save it again.`,
        );
    }
    // allow(silent-catch): the refusal below says the fetch failed; the network's own words name nothing to do
    const response = await fetch(url, { credentials: "include" }).catch(() => undefined);
    if (response === undefined || !response.ok) {
        throw new RefusedError(`Neither the page nor this browser could fetch that file from ${host}${response === undefined ? "" : ` (it answered ${response.status})`}.`);
    }
    return { data: await cappedBody(response), claimed: response.headers.get("content-type") ?? "", attachment: isAttachment(response) };
};

const fetchMedia = async (tab: TargetTab, url: string): Promise<Fetched> => {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
    if (scheme === "data") {
        return await fromDataUrl(url);
    }
    if (scheme !== "http" && scheme !== "https" && scheme !== "blob") {
        throw new RefusedError(`"${url.slice(0, 80)}" is not an address a file can be fetched from: pass an http(s), blob: or data: address, or the file's ref.`);
    }
    const slot = crypto.randomUUID();
    try {
        const staged = await inject(tab.id, stageMedia, [url, slot, WEBEXT_MEDIA_MAX_BYTES]);
        if (staged.ok) {
            return { data: await readOut(tab.id, slot, staged.bytes), claimed: staged.type, attachment: staged.attachment === true };
        }
        if (staged.reason === "fetch" && scheme !== "blob") {
            return await fromWorker(url, staged.message);
        }
        throw new RefusedError(staged.reason === "fetch" ? `The page could not read that address (${staged.message}).` : staged.message);
    } finally {
        // allow(silent-catch): a page that navigated away has already dropped what it held
        void chrome.scripting.executeScript({ target: { tabId: tab.id }, func: dropStaged, args: [slot] }).catch(() => undefined);
    }
};

/* INTO THE SANDBOX. */

// Bytes the extension already holds, straight into the sandbox: a fetched file below, or words a kit read off a page
// (a ChatGPT answer too long to hand back in a tool answer).
export const saveBytes = async (from: SandboxKey, data: Uint8Array<ArrayBuffer>, mimeType: string, name: string, source: string): Promise<SavedMedia> => {
    const sandbox = await store.sandbox(from);
    if (sandbox === undefined) {
        throw new RefusedError(`This browser is not paired with a sandbox any more.`);
    }
    const response = await fetch(webextMediaUrl(sandbox.url), {
        method: "POST",
        headers: {
            authorization: `Bearer ${sandbox.token}`,
            "content-type": mimeType,
            [WEBEXT_MEDIA_NAME_HEADER]: encodeURIComponent(name.slice(0, 80)),
            [WEBEXT_MEDIA_SOURCE_HEADER]: source,
        },
        body: new Blob([data], { type: mimeType }),
    }).catch(() => {
        throw new RefusedError(`This browser could not reach the sandbox to hand the file over, so nothing was saved.`);
    });
    // allow(silent-catch): a body that is not JSON is the unreadable answer refused just below, with its status
    const answer = WebExtMediaAnswerSchema.safeParse(await response.json().catch(() => undefined));
    if (!answer.success) {
        throw new RefusedError(`The sandbox did not take the file (${response.status}), so nothing was saved.`);
    }
    if (!answer.data.ok) {
        throw new RefusedError(answer.data.message);
    }
    return { path: answer.data.path, bytes: answer.data.bytes, mimeType: answer.data.mimeType };
};

export interface SaveOptions {
    // The page itself pointed at this file: a ref the agent aimed at, or a download the page started. Then any file but
    // a web page is kept. Left out, `url` is treated as an address from elsewhere and keptFromAddress decides.
    readonly pointedAt?: boolean;
}

// Fetches `url` (http(s), blob: or data:) in the context of tab `tabId`, so the page's own cookies and its blob URLs
// work, and stores the bytes in sandbox `from`. `name` is a suggested file-name stem the sandbox sanitizes. Verifies
// itself that the tab is permitted for read (so no caller can skip policy) and throws RefusedError with an agent-facing
// message on refusal or failure. Unless `options.pointedAt`, only what keptFromAddress allows is stored.
export const saveMediaFromTab = async (from: SandboxKey, tabId: number, url: string, name: string, options: SaveOptions = {}): Promise<SavedMedia> => {
    const tab = await targetTab(from, "read", tabId);
    const fetched = await fetchMedia(tab, url);
    if (fetched.data.byteLength === 0) {
        throw new RefusedError(`That address answered with an empty file, so nothing was saved.`);
    }
    const mimeType = verifiedType(fetched.data.subarray(0, 512), fetched.claimed);
    if (options.pointedAt !== true) {
        keptFromAddress(mimeType, fetched.attachment);
    }
    return await saveBytes(from, fetched.data, mimeType, name, new URL(tab.url).host);
};
