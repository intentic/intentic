import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import { WEB_DIST } from "./tier.js";

// The web build served the way the platform's web image serves it (_editor/web nginx.conf + entrypoint.sh), minus what a
// sign-in cannot tell apart: a file of `dist` when one matches, the SPA's index.html for every other path, and
// `assets/js/env.js` with the two variables the entrypoint's envsubst fills.

const ENV_JS = `/assets/js/env.js`;

const TYPES = new Map([
    [`.html`, `text/html; charset=utf-8`],
    [`.js`, `text/javascript; charset=utf-8`],
    [`.mjs`, `text/javascript; charset=utf-8`],
    [`.css`, `text/css; charset=utf-8`],
    [`.json`, `application/json`],
    [`.webmanifest`, `application/manifest+json`],
    [`.wasm`, `application/wasm`],
    [`.svg`, `image/svg+xml`],
    [`.png`, `image/png`],
    [`.ico`, `image/x-icon`],
    [`.woff`, `font/woff`],
    [`.woff2`, `font/woff2`],
    [`.ttf`, `font/ttf`],
    [`.txt`, `text/plain; charset=utf-8`],
]);

export interface WebServer {
    readonly origin: string;
    /** The api the page is told to call; env.js is written with it on each request, so it may be set after listening. */
    readonly pointAt: (apiUrl: string) => void;
    readonly close: () => Promise<void>;
}

const inDist = (path: string): string | undefined => {
    const file = join(WEB_DIST, normalize(path));
    return file.startsWith(`${WEB_DIST}${sep}`) && statSync(file, { throwIfNoEntry: false })?.isFile() === true ? file : undefined;
};

export const serveWeb = async (): Promise<WebServer> => {
    let apiUrl = ``;
    // entrypoint.sh: `envsubst '$API_URL $POSTHOG_KEY'`. An empty key is analytics off, as a deploy without one is.
    const envJs = (): string => readFileSync(join(WEB_DIST, ENV_JS), `utf8`).replaceAll(`$API_URL`, apiUrl).replaceAll(`$POSTHOG_KEY`, ``);
    const server = createServer((request, response) => {
        const path = decodeURIComponent(new URL(request.url ?? `/`, `http://localhost`).pathname);
        if (path === ENV_JS) {
            response.writeHead(200, { "content-type": `text/javascript; charset=utf-8`, "cache-control": `no-store` });
            response.end(envJs());
            return;
        }
        const file = inDist(path);
        // A missing asset is a 404, as nginx answers one; only a path without an extension is the SPA's to route.
        if (file === undefined && extname(path) !== ``) {
            response.writeHead(404).end();
            return;
        }
        const served = file ?? join(WEB_DIST, `index.html`);
        response.writeHead(200, { "content-type": TYPES.get(extname(served)) ?? `application/octet-stream`, "cache-control": `no-store` });
        createReadStream(served).pipe(response);
    });
    // `localhost`, not 127.0.0.1: the api's CORS and Better Auth trust the web origin by its exact string, and the page and
    // the api must be the same site for the session cookie to ride from one to the other.
    await new Promise<void>((resolve) => server.listen(0, `127.0.0.1`, resolve));
    // SAFETY: a TCP listener's address is an AddressInfo; only one on a pipe or socket path is a string.
    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    return {
        origin,
        pointAt: (url) => {
            apiUrl = url;
        },
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
};
