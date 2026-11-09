/* THE EDITOR'S COPY OF ITSELF AT THE EDGE (Worker `intentic-app-edge`, on the route app.intentic.dev/*).

app.intentic.dev is an nginx container (../Dockerfile) on the same box and tunnel as the platform api and Postgres, so
when that box is down the editor answers Cloudflare's 52x/530 and cannot even load, for everyone the service worker
(../public/sw.js) has not already kept a copy for. The editor's outage mode opens remembered sandboxes without the
platform; it only needs the page. This Worker sits in front of the origin and passes every request through to it
untouched, and only when the origin fails does it answer from its static assets: the released editor, copied by
deploy-edge.sh right after the release rolled the origin, with index.html and env.js as the live container rewrote them.

The same rule as sw.js `fallsBack`: the origin failed when it threw, answered 500 or 502–599 (501 is an answer), or,
for a GET or HEAD, gave no answer before a deadline. Anything else it says is the answer, including 4xx. Never the copy
for a write, for /wire/ (the PostHog proxy, which the copy cannot answer), or for a ranged request: those get the
origin's answer as it is. */

// The bindings: the copy (wrangler.jsonc `assets`, served only through this Worker: `run_worker_first`), and the origin
// a request off the route is passed to (https://app.intentic.dev; `wrangler dev --var UPSTREAM:…` points it at a fake
// one to watch a failing origin).
interface Env {
    readonly ASSETS: { fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> };
    readonly UPSTREAM: string;
}

// The hostname this Worker fronts. On a zone route, a Worker's fetch of its own hostname goes to the origin, not back
// into the Worker. Anywhere else (the workers.dev address it is tested on) it passes the request to UPSTREAM.
const APP_HOST = `app.intentic.dev`;

// The test hook: this request header serves the copy without asking the origin. Harmless, since everything the copy
// holds is the public editor anyone can load.
const FORCE_HEADER = `x-intentic-edge-fallback`;
// Stamped on every answer from the copy, so a person, the status page and a deploy check can tell it from the origin.
const SERVED_BY = { name: `x-intentic-served-by`, value: `edge-fallback` };

// HOW LONG THE ORIGIN GETS before the copy answers instead, measured to the response's HEADERS, never its body: a slow
// download is the client's link, not a dead origin. A healthy nginx answers a navigation in well under a second, and
// Cloudflare gives up on an unreachable one only after ~19 s (522) or 100 s (524) — the hung-box case this is for. A
// navigation is someone staring at a blank tab, so it gets the shorter wait; an asset GET gets longer, since the page
// asking for it already loaded from the origin, and an origin that is only slow is still the one sure to hold every
// file of its build. The service worker waits 15 s for a navigation before its own copy, so this one answers first.
const NAVIGATION_DEADLINE_MS = 10_000;
const ASSET_DEADLINE_MS = 15_000;

// Where deploy-edge.sh writes what it captured from the live origin: the security headers its shell carries and the
// release the copy is. Never served as itself: it is the Worker's, not the editor's.
const EDGE_DIR = `/__edge/`;
const SHELL_META = `${EDGE_DIR}shell.json`;

// The statuses a dead origin is served as (sw.js `fallsBack`): 500, and 502 through 599, Cloudflare's 52x and 530.
const fallsBack = (status: number): boolean => status === 500 || (status >= 502 && status <= 599);

// Whether the copy may ever answer this request (see the header).
const mayFallBack = (request: Request, path: string): boolean =>
    (request.method === `GET` || request.method === `HEAD`) && !request.headers.has(`range`) && !path.startsWith(`/wire/`);

// Paths nginx answers 404 for rather than the shell (nginx.conf: `try_files $uri =404`): a missing chunk, font or
// runtime file is a miss, never index.html served under its name. Every other path is the app's, as there.
const NEVER_THE_SHELL = /^\/(?:assets|fonts)\/|^\/\.well-known\/assetlinks\.json$/;

// A navigation, for the deadline: what a browser opening a page sends, or a path with no file extension.
const isNavigation = (request: Request, path: string): boolean =>
    request.headers.get(`sec-fetch-mode`) === `navigate` ||
    (request.headers.get(`accept`) ?? ``).includes(`text/html`) ||
    (!NEVER_THE_SHELL.test(path) && !/\.[A-Za-z0-9]+$/.test(path));

// Cache-Control for a file the copy has: nginx.conf's `$cache_control` map for the statuses it caches, so a browser
// keeps an edge answer exactly as long as it would have kept the origin's.
const cacheControlOf = (path: string): string => {
    if (path === `/sw.js`) {
        return `no-cache`;
    }
    if (path === `/assets/js/env.js`) {
        return `no-store`;
    }
    if (path.startsWith(`/assets/`)) {
        return `public, max-age=31536000, immutable`;
    }
    if (path.startsWith(`/fonts/`)) {
        return `public, max-age=604800, stale-while-revalidate=2592000`;
    }
    if (path.startsWith(`/ext-shims/`)) {
        return `no-cache`;
    }
    return `no-store`;
};

// What deploy-edge.sh wrote to SHELL_META: the release the copy is, and the live shell's security headers by name.
interface ShellMeta {
    readonly version: string;
    readonly build: string;
    readonly headers: Record<string, string>;
}

// The security headers the live shell sent when the copy was taken (deploy-edge.sh), read once per isolate. Captured
// rather than written here, so they cannot drift from nginx.conf. A copy without the file still answers, bare.
let shellHeaders: Promise<Record<string, string>> | undefined;
const securityHeaders = (env: Env, base: string): Promise<Record<string, string>> => {
    shellHeaders ??= env.ASSETS.fetch(new URL(SHELL_META, base))
        .then(async (response) => {
            // SAFETY: deploy-edge.sh writes this file, in this shape, beside the copy it describes, and nothing else does.
            const meta = (await response.json()) as ShellMeta;
            return meta.headers;
        })
        .catch((cause: unknown) => {
            shellHeaders = undefined;
            console.error(`[edge] no captured shell headers:`, cause);
            return {};
        });
    return shellHeaders;
};

// One file of the copy, dressed as nginx would have sent it, or undefined when the copy has no such file. Asked for
// with a bare GET, so a conditional or encoded variant never comes back in place of the bytes.
const copyFile = async (env: Env, request: Request, path: string, cacheControl: string): Promise<Response | undefined> => {
    const file = await env.ASSETS.fetch(new URL(path, request.url));
    if (file.status !== 200) {
        await file.body?.cancel();
        return undefined;
    }
    const headers = new Headers({ "cache-control": cacheControl, [SERVED_BY.name]: SERVED_BY.value });
    for (const name of [`content-type`, `etag`, `last-modified`]) {
        const value = file.headers.get(name);
        if (value !== null) {
            headers.set(name, value);
        }
    }
    for (const [name, value] of Object.entries(await securityHeaders(env, request.url))) {
        headers.set(name, value);
    }
    if (request.method === `HEAD`) {
        await file.body?.cancel();
        return new Response(null, { status: 200, headers });
    }
    return new Response(file.body, { status: 200, headers });
};

// The copy's answer to a path: the file, else the shell for a path that is the app's, else undefined (a miss).
const fromCopy = async (env: Env, request: Request, path: string): Promise<Response | undefined> => {
    if (!path.startsWith(EDGE_DIR)) {
        const file = await copyFile(env, request, path, cacheControlOf(path));
        if (file !== undefined) {
            return file;
        }
    }
    return NEVER_THE_SHELL.test(path) ? undefined : copyFile(env, request, `/index.html`, `no-store`);
};

// A miss the origin gave no answer for: 404 when nobody asked the origin (the test hook), 502 when it was asked and
// failed, which is the status sw.js keeps its own copy for. Never cacheable: a cached 404 for a chunk name is what kept
// browsers reloading /sandbox in a loop on 2026-10-27 (nginx.conf).
const miss = async (env: Env, request: Request, status: 404 | 502): Promise<Response> => {
    const headers = new Headers({ "cache-control": `no-store`, "content-type": `text/plain; charset=utf-8`, [SERVED_BY.name]: SERVED_BY.value });
    for (const [name, value] of Object.entries(await securityHeaders(env, request.url))) {
        headers.set(name, value);
    }
    const body = status === 404 ? `Not found in the editor's edge copy.\n` : `The editor's origin did not answer, and its edge copy has no such file.\n`;
    return new Response(request.method === `HEAD` ? null : body, { status, headers });
};

const TIMED_OUT = Symbol(`timed out`);
type Outcome = { readonly response: Response } | { readonly error: unknown };

// The origin's answer, or the copy's when the origin failed. The copy answers a deadline only when it has the file:
// for a miss, the origin's late answer is still the best one there is, as sw.js keeps waiting when it has no copy.
const originOrCopy = async (env: Env, request: Request, upstream: Request, path: string): Promise<Response> => {
    const abort = new AbortController();
    const answer: Promise<Outcome> = fetch(upstream, { signal: abort.signal }).then(
        (response) => ({ response }),
        (cause: unknown) => ({ error: cause }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), isNavigation(request, path) ? NAVIGATION_DEADLINE_MS : ASSET_DEADLINE_MS);
    });
    const first = await Promise.race([answer, deadline]);
    clearTimeout(timer);

    if (first === TIMED_OUT) {
        const copy = await fromCopy(env, request, path);
        if (copy !== undefined) {
            abort.abort();
            return copy;
        }
    }
    const outcome = first === TIMED_OUT ? await answer : first;
    if (`response` in outcome && !fallsBack(outcome.response.status)) {
        return outcome.response;
    }
    const copy = await fromCopy(env, request, path);
    if (copy !== undefined) {
        if (`response` in outcome) {
            await outcome.response.body?.cancel();
        }
        return copy;
    }
    // The copy has nothing either: the origin's own error page, which says more than ours would.
    return `response` in outcome ? outcome.response : miss(env, request, 502);
};

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname;
        if (mayFallBack(request, path) && request.headers.get(FORCE_HEADER) === `force`) {
            return (await fromCopy(env, request, path)) ?? miss(env, request, 404);
        }
        // Same method, headers and body; on the route that is the request itself, streamed through without a copy.
        const upstream = url.hostname === APP_HOST ? request : new Request(new URL(`${path}${url.search}`, env.UPSTREAM), request);
        if (!mayFallBack(request, path)) {
            return fetch(upstream).catch((cause: unknown) => {
                console.error(`[edge] origin unreachable for ${request.method} ${path}:`, cause);
                return new Response(`The editor's origin did not answer.\n`, { status: 502, headers: { "cache-control": `no-store` } });
            });
        }
        return originOrCopy(env, request, upstream, path);
    },
};
