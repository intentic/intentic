// THE THREE OUTAGES, staged without touching the network (tier-outage.ts runs them on Windows; the Linux tier's
// _tools/desktop-smoke/outage.sh stages the first two the same way). What a reader meets when intentic is down comes in
// three shapes, and each one took a different road through the app when they were first tried by hand (2026-10-26):
// - nothing answers at all (no name, no route): the app's own offline page, which offers this computer's sandboxes;
// - the address answers with an error page (a dead host behind Cloudflare is a 5xx with a page of Cloudflare's own):
//   the app showed that page and stopped, with no retry and no way to the sandboxes on this computer;
// - only the API is down: the editor loads and says so itself (`/platform-unavailable`).
// This file is the pure half (what a request, a page listing and the app's own arguments say) and the stub that plays
// the workspace's address; nothing in it asserts.

import { errorMessage } from "@intentic/base/errors";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { listen } from "./hermetic.js";
import { asList } from "./parse.js";

/** The offline page and the sandbox face as WebView2 serves the app's bundle on Windows (offline.rs `PAGE`). */
export const OFFLINE_PAGE = `http://tauri.localhost/offline.html`;
export const FACE_PAGE = `http://tauri.localhost/files/sandbox`;

/** Hosts on RFC 2606's reserved TLD: they resolve for no one, so a scenario that leaks reaches nothing real. */
export const OUTAGE_APP_URL = `https://app.e2e.test`;
export const OUTAGE_PLATFORM_URL = `https://api.e2e.test`;

/** Where the app's Rust side is sent for anything not on loopback: a port nothing listens on, so a call fails at once. */
export const DEAD_PROXY = `http://127.0.0.1:9`;

/** What the stub saw of one request, for telling the workspace's own loads apart from the offline page's checks. */
export interface SeenRequest {
    readonly method: string;
    readonly path: string;
    readonly accept: string;
    readonly userAgent: string;
    readonly at: number;
}

/**
 * A top-level load of the workspace, as opposed to a check of whether it answers: a GET that asks for HTML. The offline
 * page's own check is a `fetch` (`Accept: *\/*`) and the app's a HEAD, and the stub's report and favicon are neither.
 * Pure.
 */
export const isNavigation = (request: SeenRequest): boolean =>
    request.method === `GET` && /\btext\/html\b/.test(request.accept) && !request.path.startsWith(`/__`) && request.path !== `/favicon.ico`;

/* THE APP'S OWN WEBVIEW2 ARGUMENTS, read from the source the build under test was made from. WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
 * replaces what the app passes rather than adding to it, and those arguments are not cosmetic: without
 * `LocalNetworkAccessChecks` disabled, the loopback calls the sandbox face makes would be put behind a permission
 * dialog, and a scenario would test a WebView the app never runs. */

/** One line of Rust without its `//` comment, a `//` inside a string literal (a URL) left alone. Pure. */
const withoutLineComment = (line: string): string => {
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === `\\` && quoted) {
            index += 1;
        } else if (char === `"`) {
            quoted = !quoted;
        } else if (!quoted && char === `/` && line[index + 1] === `/`) {
            return line.slice(0, index);
        }
    }
    return line;
};

/** The string `BROWSER_ARGS` in windows/scripts.rs concatenates, or undefined when the file no longer says it. Pure. */
export const browserArgsOf = (scriptsRs: string): string | undefined => {
    const start = scriptsRs.indexOf(`const BROWSER_ARGS: &str = concat!(`);
    if (start === -1) {
        return undefined;
    }
    // Comments first: they explain the arguments in prose that holds quotes and a `);` of its own.
    const code = scriptsRs.slice(start).split(`\n`).map(withoutLineComment).join(`\n`);
    const end = code.indexOf(`);`);
    if (end === -1) {
        return undefined;
    }
    const literals = [...code.slice(0, end).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]!.replace(/\\"/g, `"`).replace(/\\\\/g, `\\`));
    const joined = literals.join(``).trim();
    return joined === `` ? undefined : joined;
};

/** The source file the arguments are read from, relative to the repository root the workflow runs in. */
export const BROWSER_ARGS_SOURCE = join(`_editor`, `desktop-app`, `src-tauri`, `src`, `windows`, `scripts.rs`);

/** `--host-resolver-rules` that make each host fail to resolve, in Chromium's own quoting. Pure. */
export const unresolvable = (hosts: readonly string[]): string => `--host-resolver-rules="${hosts.map((host) => `MAP ${host} ~NOTFOUND`).join(`, `)}"`;

/** The app's arguments with the scenario's after them, as one WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS value. Pure. */
export const browserArguments = (appArgs: string, extra: readonly string[]): string => [appArgs, ...extra].filter((part) => part !== ``).join(` `);

/* WHAT THE WEBVIEW IS SHOWING, read from WebView2's DevTools listing (`--remote-debugging-port`): the only witness to
 * which page a window holds, since the app's frame wears "Intentic" whichever of them it is. */

export interface PageTarget {
    readonly type: string;
    readonly url: string;
}

/** One `/json/list` entry as DevTools writes it: pages, but also workers and the browser's own targets. */
interface DevToolsEntry {
    readonly type?: string;
    readonly url?: string;
}

/** `/json/list`'s text read as its page targets. Pure. */
export const pageTargets = (text: string): readonly PageTarget[] =>
    asList<DevToolsEntry>(text).flatMap((entry) => (entry.type === `page` && entry.url !== undefined ? [{ type: `page`, url: entry.url }] : []));

/** The offline page's `status` among `pages`, or undefined while none of them is the offline page. Pure. */
export const offlineStatus = (pages: readonly PageTarget[]): string | undefined => {
    for (const page of pages) {
        if (page.url.startsWith(OFFLINE_PAGE)) {
            return new URL(page.url).searchParams.get(`status`) ?? ``;
        }
    }
    return undefined;
};

/** Whether any page is on `origin` (and, given one, at that path). Pure. */
export const pageAt = (pages: readonly PageTarget[], origin: string, path?: string): boolean =>
    pages.some((page) => {
        try {
            const url = new URL(page.url);
            return url.origin === origin && (path === undefined || url.pathname === path);
        } catch {
            // allow(silent-catch): a page whose url does not parse is on no origin, so it is not at this one.
            return false;
        }
    });

/** What the stub's page reported of `window.__INTENTIC_DESKTOP__` (the page script in `READY_PAGE`). */
export interface DesktopReport {
    readonly desktop: boolean;
    readonly machineFace: boolean;
}

/** One `/__report?…` query read as a report. Pure. */
export const reportOf = (query: URLSearchParams): DesktopReport => ({
    desktop: query.get(`desktop`) === `true`,
    machineFace: query.get(`machineFace`) === `true`,
});

// The workspace once it answers: a page that says what the app told it about itself, so the tier can hold the app to
// "the face is offered only where there is one" without a debugger.
const READY_PAGE = `<!doctype html><html><head><title>Intentic outage smoke workspace</title></head><body>ready<script>
(function () {
    var d = window.__INTENTIC_DESKTOP__;
    var q = new URLSearchParams({ desktop: String(!!d), machineFace: String(!!(d && d.machineFace === true)) });
    fetch("/__report?" + q.toString(), { cache: "no-store" }).catch(function () {});
})();
</script></body></html>`;

// A Cloudflare-shaped answer from a host behind it that is down: the status and the kind of page a reader actually gets.
const CLOUDFLARE_PAGE = (status: number): string =>
    `<!doctype html><html><head><title>intentic.dev | ${status}: Cloudflare Tunnel error</title></head><body><h1>Error 1033</h1><p>Cloudflare is currently unable to resolve it.</p><p>[outage smoke: a dead platform host behind Cloudflare]</p></body></html>`;

/** What the stub answers: an error status with Cloudflare's kind of page, the ready page, or an editor build. */
export type StubMode = { readonly kind: `error`; readonly status: number } | { readonly kind: `ready` } | { readonly kind: `editor`; readonly dist: string; readonly apiUrl: string };

export interface OutageStub {
    readonly origin: string;
    readonly setMode: (mode: StubMode) => void;
    readonly requests: () => readonly SeenRequest[];
    readonly navigations: () => number;
    readonly reports: () => readonly DesktopReport[];
    readonly close: () => Promise<void>;
}

const CONTENT_TYPES = new Map([
    [`.html`, `text/html; charset=utf-8`],
    [`.js`, `text/javascript; charset=utf-8`],
    [`.mjs`, `text/javascript; charset=utf-8`],
    [`.css`, `text/css; charset=utf-8`],
    [`.json`, `application/json`],
    [`.svg`, `image/svg+xml`],
    [`.png`, `image/png`],
    [`.ico`, `image/x-icon`],
    [`.woff2`, `font/woff2`],
    [`.webmanifest`, `application/manifest+json`],
    [`.wasm`, `application/wasm`],
]);

/**
 * An editor build's file for `path`, or its `index.html` for a route (the SPA's own fallback, nginx.conf's
 * `try_files`). The deployment build's `env.js` holds `$API_URL` for the container to fill in at start, filled here with
 * a platform that cannot answer, so the editor meets exactly "the API is down" and nothing reaches the real one.
 */
const editorFile = async (dist: string, path: string, apiUrl: string): Promise<{ body: Buffer | string; type: string }> => {
    const root = normalize(dist);
    const wanted = normalize(join(root, decodeURIComponent(path.split(`?`)[0]!)));
    const inside = wanted === root || wanted.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
    const file = inside && extname(wanted) !== `` ? wanted : join(root, `index.html`);
    const body = await readFile(file).catch(async () => await readFile(join(root, `index.html`)));
    const type = CONTENT_TYPES.get(extname(file)) ?? `application/octet-stream`;
    if (file.endsWith(join(`js`, `env.js`))) {
        return { body: body.toString(`utf8`).replaceAll(`$API_URL`, apiUrl), type };
    }
    return { body, type };
};

// Never rejects: a build that cannot be read is a 500 the failure's request list shows, not an unhandled rejection.
const answer = async (mode: StubMode, request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = request.url ?? `/`;
    const headers = { "cache-control": `no-store`, connection: `close` };
    try {
        if (mode.kind === `error`) {
            response.writeHead(mode.status, { ...headers, "content-type": `text/html; charset=UTF-8`, server: `cloudflare` });
            response.end(request.method === `HEAD` ? undefined : CLOUDFLARE_PAGE(mode.status));
            return;
        }
        if (mode.kind === `ready`) {
            response.writeHead(200, { ...headers, "content-type": `text/html; charset=utf-8` });
            response.end(request.method === `HEAD` ? undefined : READY_PAGE);
            return;
        }
        const file = await editorFile(mode.dist, path, mode.apiUrl);
        response.writeHead(200, { ...headers, "content-type": file.type });
        response.end(request.method === `HEAD` ? undefined : file.body);
    } catch (error) {
        response.writeHead(500, { ...headers, "content-type": `text/plain` });
        response.end(errorMessage(error));
    }
};

/** The workspace's address for a scenario, answering as `mode` says until told otherwise, and remembering what it was asked. */
export const startOutageStub = async (initial: StubMode, now: () => number = Date.now): Promise<OutageStub> => {
    let mode = initial;
    const seen: SeenRequest[] = [];
    const reported: DesktopReport[] = [];
    const server = createServer((request, response) => {
        const path = request.url ?? `/`;
        seen.push({
            method: request.method ?? ``,
            path,
            accept: String(request.headers.accept ?? ``),
            userAgent: String(request.headers[`user-agent`] ?? ``),
            at: now(),
        });
        if (path.startsWith(`/__report`)) {
            reported.push(reportOf(new URL(path, `http://stub`).searchParams));
            response.writeHead(204, { "cache-control": `no-store`, connection: `close` });
            response.end();
            return;
        }
        void answer(mode, request, response);
    });
    const port = await listen(server);
    return {
        origin: `http://127.0.0.1:${port}`,
        setMode: (next) => {
            mode = next;
        },
        requests: () => seen,
        navigations: () => seen.filter(isNavigation).length,
        reports: () => reported,
        // Its only failure is a server already closed, which is what was asked for.
        close: async () =>
            await new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
};

/** The last few requests as lines, for a failure to say what the webview actually asked for. Pure. */
export const describeRequests = (requests: readonly SeenRequest[], last = 12): string =>
    requests.length === 0
        ? `(the stub was asked for nothing)`
        : requests
              .slice(-last)
              .map((request) => `${request.method} ${request.path} accept=${request.accept || `-`} ${isNavigation(request) ? `[load]` : `[check]`}`)
              .join(`\n`);
