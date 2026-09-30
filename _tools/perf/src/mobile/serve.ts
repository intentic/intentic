import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

// The built demo, served as production serves the app: brotli, hashed assets cached for good, everything else
// revalidated, and every unknown path answered with index.html so the router owns it.

const TYPES = new Map([
    [".js", "text/javascript"],
    [".css", "text/css"],
    [".html", "text/html"],
    [".json", "application/json"],
    [".map", "application/json"],
    [".svg", "image/svg+xml"],
    [".woff2", "font/woff2"],
    [".png", "image/png"],
    [".webp", "image/webp"],
    [".avif", "image/avif"],
    [".jpg", "image/jpeg"],
    [".ico", "image/x-icon"],
    [".webmanifest", "application/manifest+json"],
    [".wasm", "application/wasm"],
]);

/** A request handler that may claim a request before the static files do; returns whether it answered. */
export type Claim = (request: IncomingMessage, response: ServerResponse) => boolean;

export interface StaticServer {
    readonly origin: string;
    readonly close: () => Promise<void>;
}

export const serveBuild = async (root: string, base = "/demo/", claim?: Claim): Promise<StaticServer> => {
    const cache = new Map<string, { readonly raw: Buffer; readonly br: Buffer | undefined }>();
    const server = createServer((request, response) => {
        if (claim?.(request, response) === true) {
            return;
        }
        const path = decodeURIComponent(new URL(request.url ?? `/`, `http://x`).pathname);
        if (!path.startsWith(base)) {
            response.writeHead(302, { location: base });
            response.end();
            return;
        }
        let file = join(root, normalize(path.slice(base.length)).replace(/^\/+/u, ``));
        let found = false;
        try {
            found = statSync(file).isFile();
        } catch {
            found = false;
        }
        if (!found) {
            file = join(root, `index.html`);
        }
        const type = TYPES.get(extname(file)) ?? `application/octet-stream`;
        let body = cache.get(file);
        if (body === undefined) {
            const raw = readFileSync(file);
            const compressible = /text|javascript|json|svg/u.test(type);
            body = { raw, br: compressible ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }) : undefined };
            cache.set(file, body);
        }
        const headers = {
            "content-type": type,
            "cache-control": file.includes(`/assets/`) ? `public, max-age=31536000, immutable` : `no-cache`,
        };
        if (body.br !== undefined && /\bbr\b/u.test(String(request.headers[`accept-encoding`] ?? ``))) {
            response.writeHead(200, { ...headers, "content-encoding": `br` });
            response.end(body.br);
            return;
        }
        response.writeHead(200, headers);
        response.end(body.raw);
    });
    await new Promise<void>((resolve) => server.listen(0, `127.0.0.1`, resolve));
    // SAFETY: a server listening on a TCP port reports an address object, never the string a pipe or socket gives.
    const { port } = server.address() as AddressInfo;
    return {
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
};
