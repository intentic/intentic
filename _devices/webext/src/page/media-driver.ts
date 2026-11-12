// What runs inside a tab to move a file between a page and the sandbox (background/tools/media.ts). Every function is
// injected through chrome.scripting.executeScript, which serializes it and re-parses it inside the page, so each spells
// out everything it uses; nothing else in this module exists there. They run in the isolated world: the page's own DOM,
// cookies and blob: addresses, none of its JavaScript, and a slot on `window` no page script can see.

import type { ActionResult } from "./driver.js";

// What a ref points at, as something to fetch: an address, what kind of thing it is, and what the page calls it.
export interface MediaTarget {
    readonly ok: boolean;
    readonly url: string;
    readonly kind: string;
    readonly name: string;
    readonly message: string;
}

// The isolated world's own slots, where the page's scripts never see them: the snapshot's refs (driver.ts collectPage),
// object URLs made here, a fetched file waiting to be read out, and a file on its way into an input.
declare global {
    interface Window {
        intenticPageRefs?: Element[];
        intenticMediaUrls?: Set<string>;
        intenticStaged?: { readonly slot: string; readonly blob: Blob } | undefined;
        intenticFilePin?: { readonly pin: string; readonly input: HTMLInputElement } | undefined;
        intenticFileParts?: { readonly pin: string; readonly parts: Uint8Array<ArrayBuffer>[] } | undefined;
    }
}

// A fetched file held in the page, ready to be read out in slices: its size and the type the page's answer gave it.
export interface Staged {
    readonly ok: boolean;
    // Why it was not: the fetch itself failed (a network or cross-origin refusal the worker may get round), or the
    // answer was refused here (too large, an error status), which nothing gets round.
    readonly reason?: "fetch" | "refused";
    readonly bytes: number;
    readonly type: string;
    // The answer said it is a download (Content-Disposition: attachment): the site itself hands it out as a file.
    readonly attachment?: boolean;
    readonly message: string;
}

export interface Slice {
    readonly ok: boolean;
    readonly data: string;
}

// The file input a sandbox file will go into, found and held for putFile.
export interface FileInputFound {
    readonly ok: boolean;
    readonly message: string;
}

// Resolves a snapshot ref to the media it shows: the element itself (an img's current source, a video's or audio's, a
// canvas drawn out as a PNG, an inline svg), a link that downloads, the one picture inside a button or link (ChatGPT's
// "Generated image 1" button wraps its image), a link's own address, and as a last resort a CSS background image.
export const mediaOfRef = async (ref: string): Promise<MediaTarget> => {
    const refs = window.intenticPageRefs ?? [];
    const index = /^e(\d+)$/.exec(ref.trim());
    const el = index?.[1] === undefined ? undefined : refs[Number(index[1])];
    const none = (message: string): MediaTarget => ({ ok: false, url: "", kind: "", name: "", message });
    if (el === undefined || !el.isConnected) {
        return none(`No element ${ref} on this page: take a fresh snapshot, the page has changed.`);
    }
    const absolute = (url: string): string => new URL(url, document.baseURI).href;
    const said = (node: Element): string =>
        (node.getAttribute("alt") ?? node.getAttribute("aria-label") ?? node.getAttribute("title") ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
    // Object URLs this extension made for a canvas or an svg, revoked once the file is fetched (stageMedia).
    const made = (window.intenticMediaUrls ??= new Set<string>());
    const objectUrl = (blob: Blob): string => {
        const url = URL.createObjectURL(blob);
        made.add(url);
        return url;
    };
    const found = (url: string, kind: string, node: Element): MediaTarget => ({ ok: true, url, kind, name: said(node) || said(el), message: "" });
    const sourceOf = (node: HTMLImageElement | HTMLMediaElement): string =>
        node instanceof HTMLImageElement
            ? node.currentSrc || node.src
            : node.currentSrc || node.src || (node.querySelector("source[src]")?.getAttribute("src") ?? "");
    // A canvas holding a picture from another site is tainted, and reading it throws: that is no picture to save.
    const drawn = async (node: HTMLCanvasElement): Promise<Blob | null> => {
        try {
            return await new Promise<Blob | null>((resolve) => node.toBlob(resolve, "image/png"));
            // allow(silent-catch): a tainted canvas throws a SecurityError, which means only "nothing to save here"
        } catch {
            return null;
        }
    };
    const fromSource = (node: HTMLImageElement | HTMLMediaElement): MediaTarget | undefined => {
        const src = sourceOf(node);
        const kind = node instanceof HTMLImageElement ? "image" : node instanceof HTMLVideoElement ? "video" : "sound";
        return src === "" ? undefined : found(absolute(src), kind, node);
    };
    const fromBlob = (blob: Blob | null, node: Element): MediaTarget | undefined => (blob === null ? undefined : found(objectUrl(blob), "image", node));
    const direct = async (node: Element): Promise<MediaTarget | undefined> => {
        const media = node instanceof HTMLPictureElement ? node.querySelector("img") : node;
        if (media instanceof HTMLImageElement || media instanceof HTMLMediaElement) {
            return fromSource(media);
        }
        if (media instanceof HTMLCanvasElement) {
            return fromBlob(await drawn(media), media);
        }
        return media instanceof SVGSVGElement ? fromBlob(new Blob([new XMLSerializer().serializeToString(media)], { type: "image/svg+xml" }), media) : undefined;
    };
    const itself = await direct(el);
    if (itself !== undefined) {
        return itself;
    }
    const link = el.closest("a[href]");
    if (link instanceof HTMLAnchorElement && link.hasAttribute("download")) {
        return found(link.href, "file", link);
    }
    // The largest picture or video inside, by what it shows: a button or card wraps one, and an avatar beside it is
    // smaller.
    const inside = Array.from(el.querySelectorAll("img, video, audio, canvas, picture, svg")).slice(0, 20);
    const area = (node: Element): number => {
        const box = node.getBoundingClientRect();
        return box.width * box.height;
    };
    for (const node of inside.toSorted((a, b) => area(b) - area(a))) {
        const media = await direct(node);
        if (media !== undefined) {
            return media;
        }
    }
    if (link instanceof HTMLAnchorElement) {
        return found(link.href, "link", link);
    }
    const background = /url\(["']?([^"')]+)["']?\)/.exec(window.getComputedStyle(el).backgroundImage)?.[1];
    if (background !== undefined) {
        return found(absolute(background), "image", el);
    }
    return none(
        `${ref} holds no picture, video, sound or link to a file. Aim at an img or video line from a snapshot (or the button that shows the picture), or pass the file's address as url.`,
    );
};

// Fetches `url` from inside the page, so its cookies and its blob: addresses are the page's own, and holds the answer
// in the isolated world's `window` under `slot` for readStaged. Refused past `cap` bytes, before reading the body when
// the answer says its length.
export const stageMedia = async (url: string, slot: string, cap: number): Promise<Staged> => {
    window.intenticStaged = undefined;
    const megabytes = (bytes: number): string => `${Math.round(bytes / 1_048_576)} MB`;
    const refused = (message: string): Staged => ({ ok: false, reason: "refused", bytes: 0, type: "", message });
    let response: Response;
    try {
        response = await fetch(url, { credentials: "include" });
    } catch (error) {
        // allow(primitive-tiers): this function runs inside the page, where no import exists, so errorMessage cannot be used
        return { ok: false, reason: "fetch", bytes: 0, type: "", message: error instanceof Error ? error.message : String(error) };
    }
    if (!response.ok) {
        return refused(`The page's own request for that file answered ${response.status}${response.status === 401 || response.status === 403 ? ": it may need a sign-in this page no longer holds" : ""}.`);
    }
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > cap) {
        return refused(`That file is ${megabytes(declared)}; one save carries at most ${megabytes(cap)}.`);
    }
    const blob = await response.blob();
    if (window.intenticMediaUrls?.delete(url) === true) {
        URL.revokeObjectURL(url);
    }
    if (blob.size > cap) {
        return refused(`That file is ${megabytes(blob.size)}; one save carries at most ${megabytes(cap)}.`);
    }
    window.intenticStaged = { slot, blob };
    return {
        ok: true,
        bytes: blob.size,
        type: blob.type || (response.headers.get("content-type") ?? ""),
        attachment: /^\s*attachment/iu.test(response.headers.get("content-disposition") ?? ""),
        message: "",
    };
};

// One slice of the file stageMedia holds, as base64: a slice per call, since one call's answer cannot carry tens of MB.
export const readStaged = async (slot: string, offset: number, length: number): Promise<Slice> => {
    const staged = window.intenticStaged;
    if (staged?.slot !== slot) {
        return { ok: false, data: "" };
    }
    const bytes = new Uint8Array(await staged.blob.slice(offset, offset + length).arrayBuffer());
    let binary = "";
    for (let at = 0; at < bytes.length; at += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return { ok: true, data: btoa(binary) };
};

export const dropStaged = (slot: string): boolean => {
    if (window.intenticStaged?.slot === slot) {
        window.intenticStaged = undefined;
    }
    return true;
};

// The file input a ref stands for: the input itself, the label for one, or (for the button that opens the file chooser,
// as ChatGPT's "Add files and more" does) the nearest file input around it, preferring one whose `accept` takes this
// file. Held under `pin` for putFile, since the person is asked in between and the page may redraw meanwhile.
export const findFileInput = (ref: string, pin: string, name: string, type: string): FileInputFound => {
    const refs = window.intenticPageRefs ?? [];
    const index = /^e(\d+)$/.exec(ref.trim());
    const el = index?.[1] === undefined ? undefined : refs[Number(index[1])];
    window.intenticFilePin = undefined;
    if (el === undefined || !el.isConnected) {
        return { ok: false, message: `No element ${ref} on this page: take a fresh snapshot, the page has changed.` };
    }
    const isFileInput = (node: Element | null | undefined): node is HTMLInputElement => node instanceof HTMLInputElement && node.type === "file";
    const takes = (input: HTMLInputElement): boolean => {
        const accept = input.accept.split(",").map((token) => token.trim().toLowerCase()).filter((token) => token !== "");
        const lower = name.toLowerCase();
        return (
            accept.length === 0 ||
            accept.some((token) => (token.startsWith(".") ? lower.endsWith(token) : token.endsWith("/*") ? type.startsWith(token.slice(0, -1)) : token === type))
        );
    };
    const candidates = (): HTMLInputElement[] => {
        if (isFileInput(el)) {
            return [el];
        }
        const labelled = el instanceof HTMLLabelElement ? el.control : el.closest("label")?.control;
        if (isFileInput(labelled)) {
            return [labelled];
        }
        for (let at: Element | null = el, depth = 0; at !== null && depth < 8; at = at.parentElement, depth += 1) {
            const inputs = Array.from(at.querySelectorAll("input[type=file]")).filter(isFileInput);
            if (inputs.length > 0) {
                return inputs;
            }
        }
        return [];
    };
    const inputs = candidates().filter((input) => !input.disabled);
    if (inputs.length === 0) {
        return { ok: false, message: `${ref} is not a file input, and no file input belongs to it. Aim at a "file" line from a snapshot, or at the button that opens the file chooser.` };
    }
    const input = inputs.find(takes);
    if (input === undefined) {
        return { ok: false, message: `The file input here takes only ${inputs[0]?.accept ?? "other files"}, and ${name} is ${type}.` };
    }
    window.intenticFilePin = { pin, input };
    return { ok: true, message: "" };
};

// One base64 slice of the file on its way into the page, kept beside the pinned input until putFile builds the file.
export const receiveFileSlice = (pin: string, data: string): boolean => {
    if (window.intenticFileParts?.pin !== pin) {
        window.intenticFileParts = { pin, parts: [] };
    }
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) {
        bytes[at] = binary.charCodeAt(at);
    }
    window.intenticFileParts.parts.push(bytes);
    return true;
};

// Puts the file into the input findFileInput held, as a person choosing it would leave it: in `files`, with the `input`
// and `change` events a page's own code listens for. Refused when the input left the page while the person decided.
export const putFile = (pin: string, name: string, type: string): ActionResult => {
    const pinned = window.intenticFilePin;
    const parts = window.intenticFileParts;
    window.intenticFilePin = undefined;
    window.intenticFileParts = undefined;
    if (pinned?.pin !== pin || !pinned.input.isConnected) {
        return { ok: false, message: `The file input left the page while the person was being asked, so nothing was attached. Take a fresh snapshot and try again.` };
    }
    const file = new File(parts?.pin === pin ? parts.parts : [], name, { type });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    pinned.input.files = transfer.files;
    pinned.input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    pinned.input.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, message: `attached` };
};
