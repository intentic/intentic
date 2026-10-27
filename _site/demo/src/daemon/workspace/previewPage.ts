import { PREVIEW_GUIDE_SCRIPT } from "@intentic/sandbox-contract/text/preview-guide";
import { intoHead } from "@intentic/sandbox-contract/text/pages";
import { bytesOf } from "./bytes";
import { typeOf } from "./rawFile";
import { rangedAnswer } from "./served";
import { PREVIEW_PATH, type PreviewPlan, previewPlanOf } from "./tickets";

// GET /workspace/preview/{ticket}/*: a workspace page and the files of its repository, served as the daemon serves them
// (workspace-preview.ts): the page with the preview guide first in its head, every answer sandboxed without
// `allow-same-origin`. And the same page as one document, for the frame that shows it: that frame is sandboxed into an
// opaque origin, whose requests no service worker sees, so the demo hands it the page with its stylesheets, scripts and
// pictures carried inside (world/elements.ts).

// The sandbox every answer wears, the daemon's PREVIEW_SANDBOX.
const PREVIEW_SANDBOX = `sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock allow-presentation`;

const baseHeaders = (): Headers =>
    new Headers({ "Content-Security-Policy": `${PREVIEW_SANDBOX}; frame-ancestors *`, "Access-Control-Allow-Origin": `*`, "Cache-Control": `no-cache` });

const plain = (status: 401 | 404, message: string): Response => {
    const headers = baseHeaders();
    headers.set(`Content-Type`, `text/plain; charset=utf-8`);
    return new Response(message, { status, headers });
};

const isHtml = (path: string): boolean => /\.x?html?$/iu.test(path);

const withGuide = (html: string): string => intoHead(html, `<script>${PREVIEW_GUIDE_SCRIPT}</script>`);

// The ticket and the workspace path an address under it names; a folder asks for its index.html.
const asked = (pathname: string): { readonly ticket: string; readonly rest: string } | undefined => {
    if (!pathname.startsWith(PREVIEW_PATH)) {
        return undefined;
    }
    const [ticket = ``, ...segments] = pathname.slice(PREVIEW_PATH.length).split(`/`);
    try {
        const rest = segments.map((segment) => decodeURIComponent(segment)).join(`/`);
        return segments.includes(`..`) ? undefined : { ticket, rest: rest === `` || rest.endsWith(`/`) ? `${rest}index.html` : rest };
    } catch {
        // allow(silent-catch): an address that does not decode names no file, which is the 404 below.
        return undefined;
    }
};

const fileOf = (plan: PreviewPlan, rest: string): string => (plan.root === `` ? rest : `${plan.root}/${rest}`);

// The page's text: its unsaved edits where the ticket carries them, else the file.
const pageText = (plan: PreviewPlan, file: string): string | undefined => {
    if (file === plan.entry && plan.source !== undefined) {
        return plan.source;
    }
    const bytes = bytesOf(file);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
};

/** The route itself, for whatever requests an address under a ticket. */
export const previewAnswer = (request: Request, url: URL): Response => {
    const named = asked(url.pathname);
    const plan = named === undefined ? undefined : previewPlanOf(named.ticket);
    if (named === undefined || plan === undefined) {
        return plain(401, `This preview has expired: open the page again.`);
    }
    const file = fileOf(plan, named.rest);
    if (isHtml(file)) {
        const text = pageText(plan, file);
        if (text === undefined) {
            return plain(404, `Not found`);
        }
        const headers = baseHeaders();
        headers.set(`Content-Type`, `text/html; charset=utf-8`);
        return new Response(withGuide(text), { status: 200, headers });
    }
    const bytes = bytesOf(file);
    if (bytes === undefined) {
        return plain(404, `Not found`);
    }
    const headers = baseHeaders();
    headers.set(`Content-Type`, typeOf(file));
    return rangedAnswer(bytes, request, headers);
};

const dataUrl = (file: string, bytes: Uint8Array): string => {
    let binary = ``;
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return `data:${typeOf(file).split(`;`)[0] ?? `text/plain`};base64,${btoa(binary)}`;
};

// A relative address the page names, as the workspace file beside it; undefined for one on another origin.
const besideOf = (page: string, reference: string): string | undefined => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(reference)) {
        return undefined;
    }
    const resolved = new URL(reference, `https://page.invalid/${page}`);
    return decodeURIComponent(resolved.pathname.slice(1));
};

const STYLESHEET = /<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*>/giu;
const SCRIPT_SRC = /<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/giu;
const MEDIA_SRC = /(<(?:img|source|video|audio|input)\b[^>]*\b(?:src|poster)\s*=\s*)(["'])([^"']+)\2/giu;

/** The page at `url` as one document, its stylesheets, scripts and pictures inside it; undefined for an address no
 * ticket serves. Links between pages keep their real addresses (`<base>`), which the frame's guide hands the editor. */
export const previewDocument = (url: URL): string | undefined => {
    const named = asked(url.pathname);
    const plan = named === undefined ? undefined : previewPlanOf(named.ticket);
    if (named === undefined || plan === undefined) {
        return undefined;
    }
    const file = fileOf(plan, named.rest);
    const text = pageText(plan, file);
    if (text === undefined) {
        return undefined;
    }
    const read = (reference: string): { readonly path: string; readonly bytes: Uint8Array } | undefined => {
        const path = besideOf(file, reference);
        const bytes = path === undefined ? undefined : bytesOf(path);
        return path === undefined || bytes === undefined ? undefined : { path, bytes };
    };
    const carried = text
        .replace(STYLESHEET, (tag) => {
            const found = read(/\bhref\s*=\s*["']?([^"'\s>]+)/iu.exec(tag)?.[1] ?? ``);
            return found === undefined ? tag : `<style>${new TextDecoder().decode(found.bytes)}</style>`;
        })
        .replace(SCRIPT_SRC, (tag, before: string, reference: string, after: string) => {
            const found = read(reference);
            return found === undefined ? tag : `<script${before}${after}>${new TextDecoder().decode(found.bytes).replaceAll(`</script`, `<\\/script`)}</script>`;
        })
        .replace(MEDIA_SRC, (tag, lead: string, quote: string, reference: string) => {
            const found = read(reference);
            return found === undefined ? tag : `${lead}${quote}${dataUrl(found.path, found.bytes)}${quote}`;
        });
    return intoHead(carried, `<base href="${url.href.replaceAll(`"`, `&quot;`)}"><script>${PREVIEW_GUIDE_SCRIPT}</script>`);
};
