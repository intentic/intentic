import { z } from "zod";

// A workspace web page as one self-contained document, for a sandboxed frame's `srcdoc` (HtmlPreview.vue). Every file
// it names beside itself (a stylesheet, a picture, a script, a font) is read through this window's own authenticated
// client and carried inside as data, and a policy at the top of its head refuses anything else. The frame runs with an
// opaque origin and no network, so the page's scripts can run without reaching this window, its storage, the platform's
// cookies or the sandbox's API: the only way anything gets in is what this file put in the document.
//
// The same trade the EPUB viewer makes for a chapter (_extensions/viewers/src/epub/page.ts), with scripts allowed: a
// page an agent wrote is often a chart or a deck that is nothing without them. What is left out is the internet: a
// page's CDN script or web font is counted and blocked, since fetching it would mean either the frame reaching the
// network or this window fetching whatever a page names on its behalf.

export const PREVIEW_POLICY = [
    `default-src 'none'`,
    // Inline only, which is every script this document can hold: the page's own, and its files carried in as text. Eval
    // gives nothing more to a frame that can reach nothing.
    `script-src 'unsafe-inline' 'unsafe-eval'`,
    `style-src 'unsafe-inline'`,
    `img-src data: blob:`,
    `font-src data:`,
    `media-src data: blob:`,
    `connect-src 'none'`,
    `frame-src 'none'`,
    `worker-src 'none'`,
    `object-src 'none'`,
    `form-action 'none'`,
    `base-uri 'none'`,
    `manifest-src 'none'`,
].join(`; `);

// What a reference in a page points at: a place in the page, bytes already inside it, the internet, some other scheme
// (`mailto:`, `javascript:`), or a file in the workspace.
export type RefKind = "fragment" | "inline" | "remote" | "elsewhere" | "file";

export const refKind = (raw: string): RefKind => {
    const ref = raw.trim();
    if (ref.startsWith(`#`)) {
        return `fragment`;
    }
    if (/^(?:data|blob):/i.test(ref)) {
        return `inline`;
    }
    if (/^(?:https?:)?\/\//i.test(ref)) {
        return `remote`;
    }
    if (ref === `` || /^[a-z][a-z0-9+.-]*:/i.test(ref)) {
        return `elsewhere`;
    }
    return `file`;
};

// A slash-joined path with `.` and `..` folded away; undefined when it climbs above the workspace.
const folded = (path: string): string | undefined => {
    const kept: string[] = [];
    for (const segment of path.split(`/`)) {
        if (segment === `` || segment === `.`) {
            continue;
        }
        if (segment === `..`) {
            if (kept.pop() === undefined) {
                return undefined;
            }
            continue;
        }
        kept.push(segment);
    }
    return kept.length === 0 ? undefined : kept.join(`/`);
};

// The reference's own path: query and fragment dropped, percent-escapes decoded (`My%20logo.png` is `My logo.png`).
const barePath = (ref: string): string => {
    const bare = ref.trim().split(/[?#]/, 1)[0] ?? ``;
    try {
        return decodeURIComponent(bare);
    } catch {
        return bare;
    }
};

// The workspace paths a file reference may name, most likely first. A relative one names one, from the page's folder.
// A root-absolute one (`/css/site.css`) is relative to the site's root, which nothing writes down: the page's folder
// and then each folder above it are tried. None for a reference that climbs out of the workspace.
export const candidatePaths = (from: string, ref: string): string[] => {
    const bare = barePath(ref);
    const folder = from.slice(0, from.lastIndexOf(`/`) + 1);
    if (!bare.startsWith(`/`)) {
        const path = folded(`${folder}${bare}`);
        return path === undefined ? [] : [path];
    }
    const folders: string[] = [];
    for (let at = folder; ; at = at.slice(0, at.slice(0, -1).lastIndexOf(`/`) + 1)) {
        folders.push(at);
        if (at === ``) {
            break;
        }
    }
    return [...new Set(folders.flatMap((base) => folded(`${base}${bare.slice(1)}`) ?? []))];
};

// The type a carried file is labelled with; a browser refuses an SVG picture or a font without the right one.
const MIME = new Map<string, string>([
    [`png`, `image/png`],
    [`jpg`, `image/jpeg`],
    [`jpeg`, `image/jpeg`],
    [`gif`, `image/gif`],
    [`webp`, `image/webp`],
    [`avif`, `image/avif`],
    [`svg`, `image/svg+xml`],
    [`ico`, `image/x-icon`],
    [`bmp`, `image/bmp`],
    [`woff`, `font/woff`],
    [`woff2`, `font/woff2`],
    [`ttf`, `font/ttf`],
    [`otf`, `font/otf`],
    [`css`, `text/css`],
    [`js`, `text/javascript`],
    [`mjs`, `text/javascript`],
    [`json`, `application/json`],
    [`mp4`, `video/mp4`],
    [`webm`, `video/webm`],
    [`ogv`, `video/ogg`],
    [`mp3`, `audio/mpeg`],
    [`wav`, `audio/wav`],
    [`ogg`, `audio/ogg`],
    [`m4a`, `audio/mp4`],
    [`vtt`, `text/vtt`],
]);

export const mimeOf = (path: string): string => MIME.get(path.slice(path.lastIndexOf(`.`) + 1).toLowerCase()) ?? `application/octet-stream`;

// One file past this is left out rather than carried: the whole document is held as one string, twice over.
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
// And all of them together.
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
// How deep one stylesheet's `@import`s are followed.
const MAX_IMPORT_DEPTH = 4;

const CHUNK = 0x8000;
const base64 = (bytes: Uint8Array): string => {
    let binary = ``;
    for (let index = 0; index < bytes.length; index += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
    }
    return btoa(binary);
};

// Reads a workspace file's bytes for the document, or undefined when there is none to read.
export type AssetLoader = (path: string) => Promise<Blob | undefined>;

export interface PreviewDocument {
    // The document, for `srcdoc`.
    readonly html: string;
    // Workspace files carried inside it, whose change should draw it again.
    readonly carried: readonly string[];
    // Workspace files it names that could not be carried: not there, or too large.
    readonly missing: readonly string[];
    // References to the internet, left out.
    readonly remote: number;
}

// What a page's references came to, and the one place bytes are fetched, each file once however often it is named.
const carrierFor = (load: AssetLoader) => {
    const carried = new Set<string>();
    const missing = new Set<string>();
    let remote = 0;
    let spent = 0;
    const reads = new Map<string, Promise<Blob | undefined>>();
    const read = (path: string): Promise<Blob | undefined> => {
        let reading = reads.get(path);
        if (reading === undefined) {
            // allow(silent-catch): a file that cannot be read is not carried, and the preview names it among the missing.
            reading = load(path).catch(() => undefined);
            reads.set(path, reading);
        }
        return reading;
    };

    // The file a reference names, as its path and bytes, within the budget; undefined for anything not carried, which
    // is counted as remote or missing on the way.
    const fetch = async (from: string, ref: string): Promise<{ readonly path: string; readonly blob: Blob } | undefined> => {
        const kind = refKind(ref);
        if (kind === `remote`) {
            remote += 1;
            return undefined;
        }
        if (kind !== `file`) {
            return undefined;
        }
        const candidates = candidatePaths(from, ref);
        for (const path of candidates) {
            const blob = await read(path);
            if (blob === undefined) {
                continue;
            }
            if (!carried.has(path)) {
                if (blob.size > MAX_FILE_BYTES || spent + blob.size > MAX_TOTAL_BYTES) {
                    missing.add(path);
                    return undefined;
                }
                spent += blob.size;
                carried.add(path);
            }
            return { path, blob };
        }
        if (candidates[0] !== undefined) {
            missing.add(candidates[0]);
        }
        return undefined;
    };

    const dataUrl = async (from: string, ref: string): Promise<string | undefined> => {
        const file = await fetch(from, ref);
        return file === undefined ? undefined : `data:${mimeOf(file.path)};base64,${base64(new Uint8Array(await file.blob.arrayBuffer()))}`;
    };

    const text = async (from: string, ref: string): Promise<{ readonly path: string; readonly text: string } | undefined> => {
        const file = await fetch(from, ref);
        return file === undefined ? undefined : { path: file.path, text: await file.blob.text() };
    };

    return { dataUrl, text, tally: () => ({ carried: [...carried], missing: [...missing], remote }) };
};

type Carrier = ReturnType<typeof carrierFor>;

// Replaces every match of `pattern` with what `replace` answers for it, the answers awaited together.
const replaceAsync = async (text: string, pattern: RegExp, replace: (match: RegExpMatchArray) => Promise<string>): Promise<string> => {
    const matches = [...text.matchAll(pattern)];
    const answers = await Promise.all(matches.map(replace));
    let out = ``;
    let at = 0;
    matches.forEach((match, index) => {
        out += text.slice(at, match.index) + answers[index];
        at = (match.index ?? 0) + match[0].length;
    });
    return out + text.slice(at);
};

// An `@import` (its target in group 2 or 4, its media in 5) or a `url()` (its target in 7), in one pattern so each is
// read once, from the sheet that wrote it.
const CSS_REFS = /@import\s+(?:url\(\s*(['"]?)([^'")]*)\1\s*\)|(['"])([^'"]*)\3)\s*([^;]*);|url\(\s*(['"]?)([^'")]*)\6\s*\)/gi;
const CSS_CHARSET = /@charset\s+(['"])[^'"]*\1\s*;/gi;

// A stylesheet with its imports inlined and every file it names carried, each read from the sheet's own place.
const carryCss = (css: string, from: string, carrier: Carrier, depth = 0): Promise<string> =>
    replaceAsync(css, CSS_REFS, async (match) => {
        if (!match[0].startsWith(`@`)) {
            const url = await carrier.dataUrl(from, match[7] ?? ``);
            return url === undefined ? match[0] : `url("${url}")`;
        }
        const sheet = depth < MAX_IMPORT_DEPTH ? await carrier.text(from, match[2] ?? match[4] ?? ``) : undefined;
        if (sheet === undefined) {
            // Left for the policy to refuse, which is also how an import from the internet ends.
            return match[0];
        }
        const inner = await carryCss(sheet.text.replaceAll(CSS_CHARSET, ``), sheet.path, carrier, depth + 1);
        const media = (match[5] ?? ``).trim();
        return media === `` ? inner : `@media ${media} {\n${inner}\n}`;
    });

// A carried file's text inside a raw-text element: only its own closing tag could end it early.
const rawText = (text: string, tag: "script" | "style"): string => text.replaceAll(new RegExp(`</${tag}`, `gi`), `<\\/${tag}`);

// Pictures and media: which attribute of which element holds a file.
const MEDIA_ATTRIBUTES: readonly (readonly [string, string])[] = [
    [`img`, `src`],
    [`source`, `src`],
    [`video`, `src`],
    [`video`, `poster`],
    [`audio`, `src`],
    [`track`, `src`],
    [`input`, `src`],
    [`embed`, `src`],
    [`object`, `data`],
    [`image`, `href`],
    [`image`, `xlink:href`],
];

// A `srcset`'s first candidate, the one every browser can fall back to; carried alone, which is also what a `<source>`
// in a `<picture>` reads, since it has no `src`.
const firstCandidate = (srcset: string): string => srcset.trim().split(/\s+/, 1)[0]?.replace(/,$/, ``) ?? ``;

// Clicks inside the frame, answered by the window that holds it: a link to another file in the workspace opens that
// file, a link to the internet opens in a new tab, and a place in the page is scrolled to here, since a `srcdoc`
// document resolves `#section` against the window's own address and would otherwise navigate away. Beyond those, the
// frame only says whether a mouse is over it; HtmlPreview.vue checks every message is this frame's before it acts.
const LINK_GUIDE = `(() => {
    const say = (message) => parent.postMessage({ intenticHtmlPreview: message }, "*");
    addEventListener("click", (event) => {
        const link = event.target instanceof Element ? event.target.closest("a[href], area[href]") : null;
        if (link === null || event.button !== 0) return;
        const href = link.getAttribute("href") || "";
        event.preventDefault();
        if (href.startsWith("#")) {
            let id = href.slice(1);
            // allow(silent-catch): Malformed percent escapes leave the literal fragment usable as an element id.
            try { id = decodeURIComponent(id); } catch {}
            const target = id === "" ? null : document.getElementById(id) || document.getElementsByName(id)[0];
            if (target) target.scrollIntoView();
            return;
        }
        const path = link.getAttribute("data-intentic-path");
        say(path === null ? { href } : { open: path });
    }, true);
    addEventListener("submit", (event) => event.preventDefault(), true);
    // A frame in a process of its own keeps the pointer's comings and goings from the window, whose hover never reaches
    // the page, so the frame says a mouse is over it, again every little while it moves, since a leave is not always
    // told to it and the window, which sees the pointer once it is back on its side, has then already counted it gone.
    let told = 0;
    addEventListener("pointermove", (event) => {
        if (event.pointerType === "touch" || event.timeStamp - told < 150) return;
        told = event.timeStamp;
        say({ pointer: true });
    }, true);
    addEventListener("pointerout", (event) => {
        if (event.relatedTarget !== null || event.pointerType === "touch") return;
        told = 0;
        say({ pointer: false });
    }, true);
})();`;

// Where a page's references are carried in: the document, the page's own path, and the carrier every read goes through.
interface Carrying {
    readonly doc: Document;
    readonly path: string;
    readonly carrier: Carrier;
}

// A stylesheet link becomes a style holding the sheet; an icon link, the icon as data.
const carryLinks = ({ doc, path, carrier }: Carrying): Promise<void>[] =>
    [...doc.querySelectorAll(`link[href]`)].map(async (link) => {
        const rel = (link.getAttribute(`rel`) ?? ``).toLowerCase().split(/\s+/);
        const href = link.getAttribute(`href`) ?? ``;
        if (rel.includes(`icon`)) {
            const url = await carrier.dataUrl(path, href);
            if (url !== undefined) {
                link.setAttribute(`href`, url);
            }
            return;
        }
        const sheet = rel.includes(`stylesheet`) ? await carrier.text(path, href) : undefined;
        if (sheet === undefined) {
            return;
        }
        const style = doc.createElement(`style`);
        const media = link.getAttribute(`media`);
        if (media !== null) {
            style.setAttribute(`media`, media);
        }
        style.textContent = rawText(await carryCss(sheet.text, sheet.path, carrier), `style`);
        link.replaceWith(style);
    });

// A script file becomes the script's own text, which the policy lets run where it would refuse the file.
const carryScripts = ({ doc, path, carrier }: Carrying): Promise<void>[] =>
    [...doc.querySelectorAll(`script[src]`)].map(async (script) => {
        const file = await carrier.text(path, script.getAttribute(`src`) ?? ``);
        if (file === undefined) {
            return;
        }
        for (const attribute of [`src`, `integrity`, `crossorigin`, `async`, `defer`]) {
            script.removeAttribute(attribute);
        }
        script.textContent = rawText(file.text, `script`);
    });

// Every style the page writes itself, in a style element or on an element, with its files carried.
const carryStyles = ({ doc, path, carrier }: Carrying): Promise<void>[] => [
    ...[...doc.querySelectorAll(`style`)].map(async (style) => {
        style.textContent = rawText(await carryCss(style.textContent ?? ``, path, carrier), `style`);
    }),
    ...[...doc.querySelectorAll(`[style]`)].map(async (element) => {
        element.setAttribute(`style`, await carryCss(element.getAttribute(`style`) ?? ``, path, carrier));
    }),
];

// Pictures and media as data. A picture that cannot be carried from its srcset falls back to its `src`.
const carryMedia = ({ doc, path, carrier }: Carrying): Promise<void>[] => [
    ...[...doc.querySelectorAll(`img[srcset], source[srcset]`)].map(async (element) => {
        const url = await carrier.dataUrl(path, firstCandidate(element.getAttribute(`srcset`) ?? ``));
        if (url === undefined) {
            element.removeAttribute(`srcset`);
        } else {
            element.setAttribute(`srcset`, url);
        }
    }),
    ...MEDIA_ATTRIBUTES.flatMap(([tag, attribute]) =>
        [...doc.getElementsByTagName(tag)].map(async (element) => {
            const url = await carrier.dataUrl(path, element.getAttribute(attribute) ?? ``);
            if (url !== undefined) {
                element.setAttribute(attribute, url);
            }
        }),
    ),
];

// A link to another file in the workspace is followed by the window, which opens it (LINK_GUIDE).
const markLinks = ({ doc, path }: Carrying): void => {
    for (const link of doc.querySelectorAll(`a[href], area[href]`)) {
        const href = link.getAttribute(`href`) ?? ``;
        const target = refKind(href) === `file` ? candidatePaths(path, href)[0] : undefined;
        if (target !== undefined) {
            link.setAttribute(`data-intentic-path`, target);
        }
    }
};

// First in the head, so nothing the page carries is read before the policy that governs it.
const seal = (doc: Document): void => {
    const policy = doc.createElement(`meta`);
    policy.setAttribute(`http-equiv`, `Content-Security-Policy`);
    policy.setAttribute(`content`, PREVIEW_POLICY);
    const referrer = doc.createElement(`meta`);
    referrer.setAttribute(`name`, `referrer`);
    referrer.setAttribute(`content`, `no-referrer`);
    const guide = doc.createElement(`script`);
    guide.textContent = LINK_GUIDE;
    doc.head.prepend(policy, referrer, guide);
};

// What a frame's message may ask of the window, parsed where it arrives since the page's own scripts can post anything:
// a workspace file to open, named as a path inside the workspace, or an internet address to open in a tab; or what it
// tells, whether a mouse is over it, which at worst shows a Copy button over the page.
export const PreviewAskSchema = z.object({
    intenticHtmlPreview: z.union([
        z.object({
            open: z
                .string()
                .min(1)
                .refine((path) => !path.startsWith(`/`) && !path.split(`/`).includes(`..`)),
        }),
        z.object({ href: z.string().regex(/^https?:\/\//i) }),
        z.object({ pointer: z.boolean() }),
    ]),
});

// The page at `path`, from its `source`, as one document for a sandboxed frame; `load` reads a file beside it.
export const buildPreviewDocument = async (source: string, path: string, load: AssetLoader): Promise<PreviewDocument> => {
    const doc = new DOMParser().parseFromString(source, `text/html`);
    const carrying: Carrying = { doc, path, carrier: carrierFor(load) };
    // A page's own base would move where its references point, and a refresh would take the frame elsewhere.
    for (const element of doc.querySelectorAll(`base, meta[http-equiv="refresh" i]`)) {
        element.remove();
    }
    // Every reference read at once. A linked sheet's new style element joins the document only after its read is back,
    // by which time the page's own styles have been listed, so no sheet is carried twice.
    await Promise.all([...carryLinks(carrying), ...carryScripts(carrying), ...carryStyles(carrying), ...carryMedia(carrying)]);
    markLinks(carrying);
    seal(doc);
    // A page written without a doctype renders in quirks mode, and keeps doing so here.
    const doctype = doc.doctype === null ? `` : `<!DOCTYPE ${doc.doctype.name}>`;
    return { html: `${doctype}${doc.documentElement.outerHTML}`, ...carrying.carrier.tally() };
};
