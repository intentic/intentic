import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Context } from "hono";
import { isInside } from "@intentic/base/contained";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { Fence } from "@intentic/sandbox-contract/policy/fence-paths";
import { PREVIEW_GUIDE_SCRIPT } from "@intentic/sandbox-contract/text/preview-guide";
import { intoHead } from "@intentic/sandbox-contract/text/pages";
import type { AppEnv } from "../../app-env.js";
import type { MediaTickets } from "../../auth/tokens/media-tickets.js";
import { fenceOpens } from "../layout/workspace-fence.js";
import { MAX_RAW_BYTES, contentTypeForPath, openWorkspaceFileRange, parseByteRange } from "./workspace-files-download.js";
import { type OpenedWorkspaceFile, openWorkspaceFile } from "./workspace-files.js";
import { realWithin, resolveWorkspacePath } from "./workspace-files-paths.js";

// A workspace web page served the way a static file server would serve it, so it runs as it was written: its scripts,
// module imports, fetches, workers and links resolve against real addresses beside it, and it reaches the internet like
// any page. The editor frames it from GET /workspace/preview/{ticket}/<path> (HtmlPreview.vue).
//
// What keeps that safe is the origin, not a seal on the page: every answer carries `Content-Security-Policy: sandbox`
// without `allow-same-origin`, so the page (and anything it opens) runs in an opaque origin, framed or not. It cannot
// read the editor, its storage or the daemon's API, which takes only a bearer it never sees. What it CAN read is what
// the ticket serves: the files of its own repository, and of no repository nested inside it, never a hidden file
// (`.env`, `.git`), never the sandbox's control plane, never past the fence of whoever minted it.
//
// The ticket is the path's first segment, so every relative address the page names carries it on. An address from the
// server's root (`/assets/app.js`) would leave it, so those in the page's markup and stylesheets are rewritten under
// the folder the page reads as its site's root, and an import map does the same for module specifiers.

export const PREVIEW_PATH = "/workspace/preview/";

// A ticket lives as long as a media ticket, the length of a sitting; one that carries unsaved text, an hour.
const PREVIEW_TICKET_TTL_MS = 8 * 60 * 60 * 1000;
const UNSAVED_TICKET_TTL_MS = 60 * 60 * 1000;

// How many root-absolute references the site's root is guessed from, and how many tickets keep their plan parsed.
const SITE_REFS_READ = 64;
const PLANS_HELD = 64;

// What a ticket buys, fixed when it was minted.
export interface PreviewPlan {
    // The folder addresses under the ticket name files in: the page's repository, else the scope's root.
    readonly root: string;
    // The scope's root (the shared tree or a conversation's checkout), which the fence and the control plane are read
    // against.
    readonly scope: string;
    // The page, absolute.
    readonly entry: string;
    // Where an address from the server's root lands, relative to `root` ("" for root itself).
    readonly site: string;
    readonly fence: Fence;
    // The page's text as the editor held it, unsaved, served in place of the file.
    readonly source?: string;
}

const BINDING_PREFIX = "preview:";

export const previewBinding = (plan: PreviewPlan): string => `${BINDING_PREFIX}${JSON.stringify(plan)}`;

const planOfPreviewBinding = (binding: string | undefined): PreviewPlan | undefined =>
    // SAFETY: only previewBinding writes this prefix, from a PreviewPlan, into a ticket store nothing else writes to.
    binding?.startsWith(BINDING_PREFIX) === true ? (JSON.parse(binding.slice(BINDING_PREFIX.length)) as PreviewPlan) : undefined;

export const previewTicketTtl = (plan: PreviewPlan): number => (plan.source === undefined ? PREVIEW_TICKET_TTL_MS : UNSAVED_TICKET_TTL_MS);

const exists = (path: string): Promise<boolean> =>
    stat(path).then(
        () => true,
        () => false,
    );

// A path's segments under the ticket, each escaped once, so a space or a `#` in a file's name stays part of it.
const encodePath = (path: string): string => path.split(sep).join("/").split("/").map(encodeURIComponent).join("/");

// The page's own repository: the nearest folder at or above it, up to the scope's root, that holds a `.git`.
const repositoryOf = async (dir: string, scope: string): Promise<string> => {
    for (let at = dir; ; at = dirname(at)) {
        if (await exists(join(at, ".git"))) {
            return at;
        }
        if (at === scope || !isInside(scope, at) || dirname(at) === at) {
            return scope;
        }
    }
};

// Root-absolute addresses the page's markup names (`src="/assets/app.js"`), without query or fragment.
const ROOT_ABSOLUTE_ATTRIBUTE = /\s(?:src|href|poster|data|action|formaction|background|xlink:href)\s*=\s*["']?\/(?![/\\])([^"'\s>?#]*)/gi;

const rootAbsoluteRefs = (html: string): string[] => {
    const refs = new Set<string>();
    for (const match of html.matchAll(ROOT_ABSOLUTE_ATTRIBUTE)) {
        const ref = match[1] ?? ``;
        if (ref !== `` && !ref.endsWith(`/`)) {
            try {
                refs.add(decodeURIComponent(ref));
            } catch {
                refs.add(ref);
            }
        }
        if (refs.size >= SITE_REFS_READ) {
            break;
        }
    }
    return [...refs];
};

// The folder a page's root-absolute addresses were written against: of the page's own folder and each one above it
// within `root`, the one where most of them exist, the nearest on a tie; the page's folder when none name anything.
// A built site (`dist/index.html` naming `/assets/app.js`) reads from `dist`, as `npx serve dist` would serve it.
export const siteRootOf = async (html: string, entryDir: string, root: string): Promise<string> => {
    const refs = rootAbsoluteRefs(html);
    let best = { dir: entryDir, hits: 0 };
    if (refs.length > 0) {
        for (let at = entryDir; ; at = dirname(at)) {
            const found = await Promise.all(refs.map((ref) => exists(join(at, ref))));
            const hits = found.filter(Boolean).length;
            if (hits > best.hits) {
                best = { dir: at, hits };
            }
            if (at === root || dirname(at) === at) {
                break;
            }
        }
    }
    return relative(root, best.dir);
};

// What a ticket for this page serves, worked out once at minting.
export const previewPlan = async (input: {
    readonly scope: string;
    readonly entry: string;
    readonly fence: Fence;
    readonly source?: string | undefined;
}): Promise<PreviewPlan> => {
    const entryDir = dirname(input.entry);
    const root = await repositoryOf(entryDir, input.scope);
    const html = input.source ?? (await readFile(input.entry, `latin1`));
    const plan: PreviewPlan = { root, scope: input.scope, entry: input.entry, site: await siteRootOf(html, entryDir, root), fence: input.fence };
    if (input.source === undefined) {
        return plan;
    }
    return { ...plan, source: input.source };
};

// The page's address on the daemon, and the served folder as a workspace path, for the editor.
export const previewAddress = (ticket: string, plan: PreviewPlan) => ({
    page: `${PREVIEW_PATH}${ticket}/${encodePath(relative(plan.root, plan.entry))}`,
    root: relative(plan.scope, plan.root).split(sep).join("/"),
});

// Whether an address under the ticket may be served, by its segments alone: no climbing, no `.git`, and no hidden
// segment except those on the way to the page itself (a page inside `.vitepress/dist` reads its own folder).
export const servableSegments = (segments: readonly string[], entrySegments: readonly string[]): boolean => {
    let shared = 0;
    while (shared < segments.length && shared < entrySegments.length && segments[shared] === entrySegments[shared]) {
        shared += 1;
    }
    return segments.every(
        (segment, index) =>
            segment !== `..` && segment !== `.` && segment !== `.git` && !segment.includes(`\0`) && (index < shared || !segment.startsWith(`.`)),
    );
};

// Whether a repository other than the page's sits between the served folder and the file.
const insideNestedRepository = async (root: string, file: string): Promise<boolean> => {
    for (let at = dirname(file); at !== root && isInside(root, at); at = dirname(at)) {
        if (await exists(join(at, `.git`))) {
            return true;
        }
    }
    return false;
};

// Types a browser insists on for a page's own files (a module needs a script type, `instantiateStreaming` a wasm one),
// over the raw route's, which names only what it draws itself.
const WEB_TYPES = new Map(
    Object.entries({
        html: `text/html`,
        htm: `text/html`,
        xhtml: `application/xhtml+xml`,
        css: `text/css; charset=utf-8`,
        js: `text/javascript; charset=utf-8`,
        mjs: `text/javascript; charset=utf-8`,
        cjs: `text/javascript; charset=utf-8`,
        jsx: `text/javascript; charset=utf-8`,
        json: `application/json; charset=utf-8`,
        map: `application/json; charset=utf-8`,
        webmanifest: `application/manifest+json; charset=utf-8`,
        wasm: `application/wasm`,
        txt: `text/plain; charset=utf-8`,
        md: `text/plain; charset=utf-8`,
        csv: `text/csv; charset=utf-8`,
        tsv: `text/tab-separated-values; charset=utf-8`,
        xml: `application/xml`,
        svg: `image/svg+xml`,
        woff: `font/woff`,
        woff2: `font/woff2`,
        ttf: `font/ttf`,
        otf: `font/otf`,
        glb: `model/gltf-binary`,
        gltf: `model/gltf+json`,
        vtt: `text/vtt; charset=utf-8`,
    }),
);

const typeOf = (path: string): string => WEB_TYPES.get(path.slice(path.lastIndexOf(`.`) + 1).toLowerCase()) ?? contentTypeForPath(path);

const isHtml = (path: string): boolean => /\.x?html?$/i.test(path);

// The sandbox every answer wears, framed or opened on its own: scripts, forms, popups that escape it (a link opened in a
// tab runs as a page of its own), dialogs, downloads; never `allow-same-origin`, which is the whole of the isolation.
export const PREVIEW_SANDBOX = `sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock allow-presentation`;

const baseHeaders = () => ({
    "Content-Security-Policy": `${PREVIEW_SANDBOX}; frame-ancestors * tauri:`,
    // The page's origin is opaque, so its own files are cross-origin to it: a module script, a font or a fetch needs
    // this to be read at all. The ticket is the credential, so this reveals nothing its holder could not fetch.
    "Access-Control-Allow-Origin": `*`,
    // Revalidated rather than reused blind, so a file an agent rewrote is what the next load sees.
    "Cache-Control": `no-cache`,
});

// A root-absolute address rewritten under the site's root on the ticket, in markup, inline styles and stylesheets.
export const rewriteRootAbsolute = (text: string, prefix: string): string =>
    text
        .replace(/(\s(?:src|href|poster|data|action|formaction|background|xlink:href)\s*=\s*)(["']?)\/(?![/\\])/gi, `$1$2${prefix}`)
        .replace(
            /(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi,
            (_, lead: string, quote: string, set: string) => `${lead}${quote}${set.replace(/(^|,)(\s*)\/(?![/\\])/g, `$1$2${prefix}`)}${quote}`,
        )
        .replace(/url\(\s*(["']?)\/(?![/\\])/gi, `url($1${prefix}`)
        .replace(/@import\s+(["'])\/(?![/\\])/gi, `@import $1${prefix}`);

const DECLARED_CHARSET = /<meta\s[^>]*charset\s*=\s*["']?\s*([\w-]+)/i;

// The guide first in the head, after a declared charset so that still opens the document; and, for a page with modules
// and no import map of its own, a map sending root-absolute specifiers where the markup's addresses went.
const preparePage = (html: string, ticketPrefix: string, sitePrefix: string): string => {
    const rewritten = rewriteRootAbsolute(html, sitePrefix);
    const modules = /<script[^>]*\stype\s*=\s*["']?module/i.test(rewritten) && !/<script[^>]*\stype\s*=\s*["']?importmap/i.test(rewritten);
    const map = modules ? `<script type="importmap">${JSON.stringify({ imports: { "/": sitePrefix, [ticketPrefix]: ticketPrefix } })}</script>` : ``;
    const inner = `<script>${PREVIEW_GUIDE_SCRIPT}</script>${map}`;
    const charset = DECLARED_CHARSET.exec(rewritten.slice(0, 4096));
    if (charset !== null) {
        const close = rewritten.indexOf(`>`, charset.index);
        return rewritten.slice(0, close + 1) + inner + rewritten.slice(close + 1);
    }
    return intoHead(rewritten, inner);
};

const plain = (c: Context<AppEnv>, status: 401 | 404 | 413, message: string): Response =>
    c.body(message, status, { ...baseHeaders(), "Content-Type": `text/plain; charset=utf-8` });

// The address's segments under the ticket, decoded, and whether it asked for a folder (it ends in a slash).
const askedSegments = (pathname: string, ticketPrefix: string): { readonly named: string[]; readonly folder: boolean } | undefined => {
    const rest = pathname.startsWith(ticketPrefix) ? pathname.slice(ticketPrefix.length) : ``;
    let segments: string[];
    try {
        segments = rest === `` ? [] : rest.split(`/`).map((segment) => decodeURIComponent(segment));
    } catch {
        // allow(silent-catch): an address whose escapes do not decode names no file, and is answered as not found.
        return undefined;
    }
    const named = segments.filter((segment) => segment !== ``);
    if (named.some((segment) => segment.includes(`/`) || segment.includes(`\\`))) {
        return undefined;
    }
    return { named, folder: segments.length === 0 || segments.at(-1) === `` };
};

// The file an address under the ticket names, or the address with a slash added for a folder asked without one; undefined
// for anything the ticket does not serve. Asks what every read of the scope asks (inside it on disk, out of its control
// plane, open to whoever minted the ticket), and what this one adds: inside the served folder once links are followed,
// in no repository nested inside it, at no hidden segment the page's own path does not take.
const locate = async (
    plan: PreviewPlan,
    asked: { readonly named: string[]; readonly folder: boolean },
): Promise<{ readonly file: string } | { readonly slash: true } | undefined> => {
    if (!servableSegments(asked.named, relative(plan.root, plan.entry).split(sep))) {
        return undefined;
    }
    let file = join(plan.root, ...asked.named);
    if ((await stat(file).catch(undefinedIfMissing))?.isDirectory() === true) {
        // A folder's own page, at an address ending in a slash so the page's relative addresses resolve inside it.
        if (!asked.folder) {
            return { slash: true };
        }
        file = join(file, `index.html`);
    }
    const scoped = relative(plan.scope, file);
    const resolved = await resolveWorkspacePath(plan.scope, scoped);
    if (resolved.kind !== `inside` || (await realWithin(plan.root, file)) === undefined) {
        return undefined;
    }
    const opens = fenceOpens(plan.fence, scoped.split(sep).join(`/`)) && fenceOpens(plan.fence, resolved.realRel.split(sep).join(`/`));
    return opens && !(await insideNestedRepository(plan.root, file)) ? { file } : undefined;
};

const heldTag = (c: Context<AppEnv>, tag: string): boolean => (c.req.header(`if-none-match`) ?? ``).split(`,`).some((held) => held.trim() === tag);

// A page or a stylesheet, its root-absolute addresses moved under the ticket and a page's guide put in. Read byte for
// byte as latin1, so a page in any encoding comes back with its bytes as they were; every rewrite here is ASCII.
const serveText = async (c: Context<AppEnv>, file: string, opened: OpenedWorkspaceFile, prefixes: Prefixes): Promise<Response> => {
    if (opened.size > MAX_RAW_BYTES) {
        return plain(c, 413, `This file is too large to preview.`);
    }
    const tag = `${opened.tag.slice(0, -1)}-p"`;
    if (heldTag(c, tag)) {
        return c.body(null, 304, { ...baseHeaders(), ETag: tag });
    }
    const text = await readFile(file, `latin1`);
    if (!isHtml(file)) {
        return c.body(Buffer.from(rewriteRootAbsolute(text, prefixes.site), `latin1`), 200, {
            ...baseHeaders(),
            "Content-Type": typeOf(file),
            ETag: tag,
        });
    }
    const page = preparePage(text, prefixes.ticket, prefixes.site);
    const declared = DECLARED_CHARSET.test(page.slice(0, 8192));
    return c.body(Buffer.from(page, `latin1`), 200, {
        ...baseHeaders(),
        "Content-Type": declared ? `text/html` : `text/html; charset=utf-8`,
        ETag: tag,
    });
};

// Any other file as it is, ranged like the media route so a page's own video seeks.
const serveBytes = (c: Context<AppEnv>, file: string, opened: OpenedWorkspaceFile): Response => {
    const headers = { ...baseHeaders(), "Content-Type": typeOf(file), ETag: opened.tag, "Accept-Ranges": `bytes` };
    if (heldTag(c, opened.tag)) {
        return c.body(null, 304, headers);
    }
    const range = parseByteRange(c.req.header(`range`), opened.size);
    if (range === `unsatisfiable`) {
        return c.body(null, 416, { ...headers, "Content-Range": `bytes */${opened.size}` });
    }
    if (!range.partial) {
        return c.body(opened.body(), 200, { ...headers, "Content-Length": String(opened.size) });
    }
    return c.body(openWorkspaceFileRange(file, range.start, range.end), 206, {
        ...headers,
        "Content-Length": String(range.end - range.start + 1),
        "Content-Range": `bytes ${range.start}-${range.end}/${opened.size}`,
    });
};

// Where the ticket's addresses begin, and where a root-absolute one lands under it.
interface Prefixes {
    readonly ticket: string;
    readonly site: string;
}

export interface PreviewServeDeps {
    readonly mediaTickets: Pick<MediaTickets, "bound">;
}

// The plan a ticket was minted with, parsed once per ticket: a page asks for dozens of files, and a plan can carry the
// page's whole text. The ticket is asked first every time, so one revoked or expired serves nothing however recently
// parsed.
const planCache = (tickets: PreviewServeDeps["mediaTickets"]) => {
    const plans = new Map<string, PreviewPlan>();
    return (ticket: string): PreviewPlan | undefined => {
        const binding = tickets.bound(ticket);
        if (binding === undefined) {
            plans.delete(ticket);
            return undefined;
        }
        const plan = plans.get(ticket) ?? planOfPreviewBinding(binding);
        if (plan !== undefined && !plans.has(ticket)) {
            plans.set(ticket, plan);
            if (plans.size > PLANS_HELD) {
                plans.delete(plans.keys().next().value ?? ``);
            }
        }
        return plan;
    };
};

// GET /workspace/preview/{ticket}/*: the page, and every file of its repository it asks for.
export const createPreviewRoute = (deps: PreviewServeDeps) => {
    const planFor = planCache(deps.mediaTickets);
    return async (c: Context<AppEnv>): Promise<Response> => {
        const ticket = c.req.param(`ticket`) ?? ``;
        const plan = planFor(ticket);
        if (plan === undefined) {
            return plain(c, 401, `This preview has expired: open the page again.`);
        }
        const pathname = new URL(c.req.url).pathname;
        const ticketPrefix = `${PREVIEW_PATH}${encodeURIComponent(ticket)}/`;
        const asked = askedSegments(pathname, ticketPrefix);
        const found = asked === undefined ? undefined : await locate(plan, asked);
        if (found === undefined) {
            return plain(c, 404, `Not found`);
        }
        if (`slash` in found) {
            return c.body(null, 301, { ...baseHeaders(), Location: `${pathname}/` });
        }
        const prefixes = { ticket: ticketPrefix, site: `${ticketPrefix}${plan.site === `` ? `` : `${encodePath(plan.site)}/`}` };
        if (resolve(found.file) === resolve(plan.entry) && plan.source !== undefined) {
            return c.body(preparePage(plan.source, prefixes.ticket, prefixes.site), 200, {
                ...baseHeaders(),
                "Content-Type": `text/html; charset=utf-8`,
            });
        }
        const opened = await openWorkspaceFile(found.file);
        if (opened === undefined) {
            return plain(c, 404, `Not found`);
        }
        return isHtml(found.file) || /\.css$/i.test(found.file) ? serveText(c, found.file, opened, prefixes) : serveBytes(c, found.file, opened);
    };
};
