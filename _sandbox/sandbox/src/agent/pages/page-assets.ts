import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";

// A page carries everything it shows inside itself, since the chat draws it in a frame that can reach nothing: the
// pictures, stylesheets and scripts it names on disk are read in as data, and the ones it names on a well-known
// library CDN are fetched here, once, at the moment it is shown. What could not be carried is reported back to the agent
// by name, so a chart that will render blank is fixed before anyone sees it, not after.

const MIB = 1024 * 1024;
// One file, read whole; a picture past this is left out rather than inflating a page into a transfer.
const MAX_FILE_BYTES = 10 * MIB;
// Every carried file together, as the bytes they cost once inline (base64 grows them by a third).
const MAX_CARRIED_BYTES = 24 * MIB;
// A fetch from a CDN that takes longer than this is left out; the page is shown without it.
const FETCH_TIMEOUT_MS = 15_000;

// Library CDNs a page may name a script, stylesheet, font or picture from. Fetched by the sandbox, never by the frame,
// so a page still reaches no network of its own; anywhere else is left out and named back to the agent.
export const PAGE_CDN_HOSTS: ReadonlySet<string> = new Set([
    "cdn.jsdelivr.net",
    "unpkg.com",
    "cdnjs.cloudflare.com",
    "d3js.org",
    "cdn.plot.ly",
    "cdn.tailwindcss.com",
    "code.jquery.com",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
]);

const IMAGE_TYPES: Readonly<Record<string, string>> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",
};
const FONT_TYPES: Readonly<Record<string, string>> = { woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf" };
const MEDIA_TYPES: Readonly<Record<string, string>> = { ...IMAGE_TYPES, ...FONT_TYPES };
const IMAGE_EXTENSIONS = Object.keys(IMAGE_TYPES).join("|");

const extensionOf = (path: string): string => path.slice(path.lastIndexOf(".") + 1).toLowerCase();

// Whether bytes are what their name says, so a renamed file or a link cannot carry some other file into a page under a
// picture's name.
const isMediaBytes = (bytes: Uint8Array, extension: string): boolean => {
    const head = String.fromCharCode(...bytes.subarray(0, 12));
    if (extension === "svg") {
        return /<svg[\s>/]/i.test(new TextDecoder().decode(bytes.subarray(0, 4096)));
    }
    if (extension in FONT_TYPES) {
        return head.startsWith("wOFF") || head.startsWith("wOF2") || head.startsWith("OTTO") || head.startsWith("\0\x01\0\0") || head.startsWith("true");
    }
    return (
        head.startsWith("\x89PNG") ||
        head.startsWith("\xff\xd8\xff") ||
        head.startsWith("GIF8") ||
        head.startsWith("\0\0\x01\0") ||
        head.startsWith("BM") ||
        (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") ||
        /^ftyp(?:avif|avis|mif1|heic)$/.test(head.slice(4, 12))
    );
};

// A reference's own path or address: fragment and query dropped for a file, kept for a URL (a CDN's query is its API).
const bareFile = (ref: string): string => {
    const bare = ref.split(/[?#]/, 1)[0] ?? "";
    try {
        return decodeURIComponent(bare);
    } catch {
        return bare;
    }
};

export interface PageCarryContext {
    // Where a relative reference in the page is read from: the file's own folder, or the turn's working folder for a
    // page written inline.
    readonly baseDir: string;
    // The folders a page may carry a file from; anything resolving outside them stays a dangling reference.
    readonly roots: readonly string[];
    // Hosts fetched from besides the library CDNs: the ones an MCP server's app declares it loads its files from.
    readonly extraHosts?: ReadonlySet<string>;
    readonly fetch?: typeof fetch;
}

export interface CarriedPage {
    readonly html: string;
    // Files on disk carried in, as the page named them.
    readonly files: readonly string[];
    // Addresses fetched from a library CDN and carried in.
    readonly fetched: readonly string[];
    // Files the page names that are not there, too large, or not what their name says.
    readonly missing: readonly string[];
    // Addresses left out: not on a library CDN, not https, or the fetch failed.
    readonly leftOut: readonly string[];
}

// One file read, and one fetch made, per page however often it is named; the budget is the page's.
const carrierFor = (context: PageCarryContext) => {
    const files = new Set<string>();
    const fetched = new Set<string>();
    const missing = new Set<string>();
    const leftOut = new Set<string>();
    let spent = 0;
    const reads = new Map<string, Promise<Uint8Array | undefined>>();
    const fetches = new Map<string, Promise<Uint8Array | undefined>>();
    const doFetch = context.fetch ?? fetch;

    const inside = (path: string): boolean => context.roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));

    const readLocal = (path: string): Promise<Uint8Array | undefined> => {
        let reading = reads.get(path);
        if (reading === undefined) {
            reading = (async () => {
                // Resolved through links first, so a link inside the workspace pointing out of it carries nothing.
                // allow(silent-catch): a file the page names that cannot be resolved is left out of it, whatever the reason.
                const real = await realpath(path).catch(() => undefined);
                if (real === undefined || !inside(real)) {
                    return undefined;
                }
                const info = await stat(real).catch(undefinedIfMissing);
                if (info === undefined || !info.isFile() || info.size > MAX_FILE_BYTES) {
                    return undefined;
                }
                return new Uint8Array(await readFile(real));
            })();
            reads.set(path, reading);
        }
        return reading;
    };

    const readRemote = (url: URL): Promise<Uint8Array | undefined> => {
        const key = url.href;
        let fetching = fetches.get(key);
        if (fetching === undefined) {
            fetching = (async () => {
                try {
                    const response = await doFetch(key, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
                    if (!response.ok) {
                        return undefined;
                    }
                    const bytes = new Uint8Array(await response.arrayBuffer());
                    return bytes.byteLength > MAX_FILE_BYTES ? undefined : bytes;
                } catch {
                    // allow(silent-catch): an asset that cannot be fetched is not carried, and the page draws it as missing.
                    return undefined;
                }
            })();
            fetches.set(key, fetching);
        }
        return fetching;
    };

    // Within the page's budget, counted once per file whatever names it.
    const afford = (key: string, bytes: Uint8Array, inline: boolean): boolean => {
        if (files.has(key) || fetched.has(key)) {
            return true;
        }
        const cost = inline ? Math.ceil(bytes.byteLength / 3) * 4 : bytes.byteLength;
        if (spent + cost > MAX_CARRIED_BYTES) {
            return false;
        }
        spent += cost;
        return true;
    };

    // What a reference names: a file on disk, an address on the internet, or something carried already (data:, a
    // place in the page, another scheme).
    const locate = (ref: string, base: string | URL): { readonly file: string } | { readonly url: URL } | undefined => {
        const trimmed = ref.trim();
        if (trimmed === "" || trimmed.startsWith("#") || /^(?:data|blob|about|javascript|mailto|tel):/i.test(trimmed)) {
            return undefined;
        }
        if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("//")) {
            const url = URL.parse(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);
            return url === null ? undefined : { url };
        }
        if (base instanceof URL) {
            const url = URL.parse(trimmed, base);
            return url === null ? undefined : { url };
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
            return undefined;
        }
        const path = bareFile(trimmed);
        return { file: isAbsolute(path) ? path : resolve(base, path) };
    };

    // The bytes a reference names, carried and counted, or undefined (with the reason recorded) when they are not.
    const bytesOf = async (
        ref: string,
        base: string | URL,
        accept: (bytes: Uint8Array, name: string) => boolean,
        inline: boolean,
    ): Promise<{ readonly bytes: Uint8Array; readonly name: string; readonly base: string | URL } | undefined> => {
        const target = locate(ref, base);
        if (target === undefined) {
            return undefined;
        }
        if ("file" in target) {
            const bytes = await readLocal(target.file);
            if (bytes === undefined || !accept(bytes, target.file) || !afford(target.file, bytes, inline)) {
                missing.add(ref.trim());
                return undefined;
            }
            files.add(target.file);
            return { bytes, name: target.file, base: dirname(target.file) };
        }
        const { url } = target;
        if (url.protocol !== "https:" || !(PAGE_CDN_HOSTS.has(url.hostname) || context.extraHosts?.has(url.hostname) === true)) {
            leftOut.add(url.href);
            return undefined;
        }
        const bytes = await readRemote(url);
        if (bytes === undefined || !accept(bytes, url.pathname) || !afford(url.href, bytes, inline)) {
            leftOut.add(url.href);
            return undefined;
        }
        fetched.add(url.href);
        return { bytes, name: url.pathname, base: url };
    };

    // A picture, font or other media as a data address. A file named without an extension the browser can type (a
    // Google Fonts face) takes the type its bytes say.
    const dataUrl = async (ref: string, base: string | URL): Promise<string | undefined> => {
        const found = await bytesOf(
            ref,
            base,
            (bytes, name) => {
                const extension = extensionOf(name);
                return extension in MEDIA_TYPES ? isMediaBytes(bytes, extension) : sniffedType(bytes) !== undefined;
            },
            true,
        );
        if (found === undefined) {
            return undefined;
        }
        const type = MEDIA_TYPES[extensionOf(found.name)] ?? sniffedType(found.bytes) ?? "application/octet-stream";
        return `data:${type};base64,${Buffer.from(found.bytes).toString("base64")}`;
    };

    // A stylesheet's or script's text, with where its own references are read from.
    const text = async (ref: string, base: string | URL): Promise<{ readonly text: string; readonly base: string | URL } | undefined> => {
        const found = await bytesOf(ref, base, (bytes) => !bytes.subarray(0, 8000).includes(0), false);
        return found === undefined ? undefined : { text: new TextDecoder().decode(found.bytes), base: found.base };
    };

    return {
        dataUrl,
        text,
        tally: () => ({ files: [...files], fetched: [...fetched], missing: [...missing], leftOut: [...leftOut] }),
    };
};

type Carrier = ReturnType<typeof carrierFor>;

// A font or picture fetched from an address whose path names no type (Google Fonts serves `…/s/inter/v13/abc`).
const sniffedType = (bytes: Uint8Array): string | undefined => {
    const head = String.fromCharCode(...bytes.subarray(0, 4));
    if (head === "wOF2") {
        return "font/woff2";
    }
    if (head === "wOFF") {
        return "font/woff";
    }
    if (head === "OTTO") {
        return "font/otf";
    }
    if (head === "\0\x01\0\0" || head === "true") {
        return "font/ttf";
    }
    return undefined;
};

// Every match of `pattern` replaced by what `replace` answers for it, the answers awaited together.
const replaceAsync = async (text: string, pattern: RegExp, replace: (match: RegExpExecArray) => Promise<string>): Promise<string> => {
    const matches = [...text.matchAll(pattern)] as RegExpExecArray[];
    const answers = await Promise.all(matches.map(replace));
    let out = "";
    let at = 0;
    matches.forEach((match, index) => {
        out += text.slice(at, match.index) + answers[index];
        at = match.index + match[0].length;
    });
    return out + text.slice(at);
};

// A stylesheet's imports and urls, in one pattern so each is read once: `@import` (target in 2 or 4, media in 5), or a
// `url()` (target in 7).
const CSS_REFS = /@import\s+(?:url\(\s*(['"]?)([^'")]*)\1\s*\)|(['"])([^'"]*)\3)\s*([^;]*);|url\(\s*(['"]?)([^'")]*)\6\s*\)/gi;
const MAX_IMPORT_DEPTH = 4;

const carryCss = (css: string, base: string | URL, carrier: Carrier, depth = 0): Promise<string> =>
    replaceAsync(css, CSS_REFS, async (match) => {
        if (!match[0].startsWith("@")) {
            const ref = match[7] ?? "";
            const url = await carrier.dataUrl(ref, base);
            // A remote sheet's relative reference that stayed out is made absolute, so it is never read as a local file.
            return url === undefined ? (base instanceof URL && !/^(?:data|https?):/i.test(ref) ? `url("${URL.parse(ref, base)?.href ?? ref}")` : match[0]) : `url("${url}")`;
        }
        const sheet = depth < MAX_IMPORT_DEPTH ? await carrier.text(match[2] ?? match[4] ?? "", base) : undefined;
        if (sheet === undefined) {
            return match[0];
        }
        const inner = await carryCss(sheet.text.replace(/@charset\s+(['"])[^'"]*\1\s*;/gi, ""), sheet.base, carrier, depth + 1);
        const media = (match[5] ?? "").trim();
        return media === "" ? inner : `@media ${media} {\n${inner}\n}`;
    });

// A file's text inside a raw-text element: only its own closing tag could end it early.
const rawText = (text: string, tag: "script" | "style"): string => text.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);

// An attribute's value in a tag's own text, quoted or not.
const attributeOf = (tag: string, name: string): string | undefined => {
    const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "i").exec(tag);
    return match === null ? undefined : (match[1] ?? match[2] ?? match[3]);
};

const withoutAttributes = (tag: string, names: readonly string[]): string =>
    names.reduce((out, name) => out.replace(new RegExp(`\\s${name}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'=<>\`]+))?`, "gi"), ""), tag);

// `<script src>` becomes the script's own text.
const SCRIPT_SRC = /<script\b[^>]*\ssrc\s*=[^>]*>\s*<\/script\s*>/gi;
const carryScripts = (html: string, base: string, carrier: Carrier): Promise<string> =>
    replaceAsync(html, SCRIPT_SRC, async (match) => {
        const open = /^<script\b[^>]*>/i.exec(match[0])?.[0] ?? "<script>";
        const src = attributeOf(open, "src");
        const file = src === undefined ? undefined : await carrier.text(src, base);
        if (file === undefined) {
            return match[0];
        }
        return `${withoutAttributes(open, ["src", "integrity", "crossorigin", "async", "defer", "referrerpolicy"])}${rawText(file.text, "script")}</script>`;
    });

// `<link rel=stylesheet>` becomes a style holding the sheet; an icon link, the icon as data.
const LINK = /<link\b[^>]*>/gi;
const carryLinks = (html: string, base: string, carrier: Carrier): Promise<string> =>
    replaceAsync(html, LINK, async (match) => {
        const tag = match[0];
        const rel = (attributeOf(tag, "rel") ?? "").toLowerCase().split(/\s+/);
        const href = attributeOf(tag, "href");
        if (href === undefined) {
            return tag;
        }
        if (rel.includes("icon")) {
            const url = await carrier.dataUrl(href, base);
            return url === undefined ? tag : tag.replace(href, url);
        }
        if (!rel.includes("stylesheet")) {
            // A preconnect or preload names an address the frame will never reach; it is dropped, not left to fail.
            return rel.some((value) => ["preconnect", "preload", "dns-prefetch", "modulepreload", "prefetch"].includes(value)) ? "" : tag;
        }
        const sheet = await carrier.text(href, base);
        if (sheet === undefined) {
            return tag;
        }
        const media = attributeOf(tag, "media");
        return `<style${media === undefined ? "" : ` media="${media.replace(/"/g, "&quot;")}"`}>${rawText(await carryCss(sheet.text, sheet.base, carrier), "style")}</style>`;
    });

// Every style the page writes itself, in a style element or on an element, with what it names carried.
const STYLE_BLOCK = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi;
const STYLE_ATTRIBUTE = /(\sstyle\s*=\s*)(["'])([^"']*?url\([^"']*?)\2/gi;
const carryStyles = async (html: string, base: string, carrier: Carrier): Promise<string> => {
    const blocks = await replaceAsync(html, STYLE_BLOCK, async (match) => `${match[1]}${rawText(await carryCss(match[2] ?? "", base, carrier), "style")}${match[3]}`);
    return replaceAsync(blocks, STYLE_ATTRIBUTE, async (match) => `${match[1]}${match[2]}${await carryCss(match[3] ?? "", base, carrier)}${match[2]}`);
};

// Pictures and media an element names by attribute; a `srcset` keeps only its first candidate, carried.
const MEDIA_ATTRIBUTE = /(<(?:img|source|video|audio|track|input|image|use)\b[^>]*?\s(?:src|poster|href|xlink:href|srcset)\s*=\s*)(["'])([^"']*)\2/gi;
const carryMedia = (html: string, base: string, carrier: Carrier): Promise<string> =>
    replaceAsync(html, MEDIA_ATTRIBUTE, async (match) => {
        const isSrcset = /\ssrcset\s*=\s*$/i.test(match[1] ?? "");
        const ref = isSrcset ? ((match[3] ?? "").trim().split(/\s+/, 1)[0]?.replace(/,$/, "") ?? "") : (match[3] ?? "");
        // An in-page reference (`<use href="#icon">`) is the page's own.
        if (ref.startsWith("#")) {
            return match[0];
        }
        const url = await carrier.dataUrl(ref, base);
        return url === undefined ? match[0] : `${match[1]}${match[2]}${url}${match[2]}`;
    });

// An absolute picture path written anywhere as a whole quoted string, a script's list of screenshots included.
const ABSOLUTE_PICTURE = new RegExp(String.raw`(["'\x60])(/(?!/)[^"'\x60\r\n]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1`, "gi");
const carryPicturePaths = (html: string, carrier: Carrier): Promise<string> =>
    replaceAsync(html, ABSOLUTE_PICTURE, async (match) => {
        const url = await carrier.dataUrl(match[2] ?? "", "/");
        return url === undefined ? match[0] : `${match[1]}${url}${match[1]}`;
    });

// The page with everything it names carried inside it, and what could not be.
export const carryPage = async (html: string, context: PageCarryContext): Promise<CarriedPage> => {
    const carrier = carrierFor(context);
    const base = context.baseDir;
    // Scripts and sheets first: what they bring in is then read for its own references along with the page's.
    let out = await carryScripts(html, base, carrier);
    out = await carryLinks(out, base, carrier);
    out = await carryStyles(out, base, carrier);
    out = await carryMedia(out, base, carrier);
    out = await carryPicturePaths(out, carrier);
    return { html: out, ...carrier.tally() };
};
