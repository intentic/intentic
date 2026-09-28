import { json, serve, servedProcedures } from "@intentic/contract-serve";
import type { LocalFolder, LocalOffice } from "@intentic/ext-onlyoffice/local-office";
import { RAW_ROUTE_LIST, type RawRouteKey, SANDBOX_ROUTE_NAMES } from "@intentic/sandbox-contract";
import { type Grant, type Grants, mayWrite } from "./grants.js";
import { cleanRelPath, resolveExisting } from "./paths.js";
import { type ProcedureContext, proceduresFor } from "./procedures.js";
import { rawFor } from "./raw.js";

// The HTTP face every window's editor talks to, on loopback only. Three gates stand before any route, because a
// loopback port is reachable by every web page the user has open, not only by the app: the Host header must name this
// port (a DNS-rebound page names its own host), a page's Origin must be one of the app's own, and the bearer must be a
// token the app granted, which decides the folder. Nothing a page sends can name a folder by itself.

// Why this side answers nothing but a folder's files, in the log line for a route the editor asked for anyway.
const NO_SANDBOX = `a folder on this computer has no sandbox behind it: no agents, git, terminals or apps`;

export interface ServerDeps {
    readonly grants: Grants;
    readonly office: LocalOffice;
    readonly context: ProcedureContext;
    // The app's own page origins (`tauri://localhost`, `http://tauri.localhost`, a dev server's).
    readonly origins: ReadonlySet<string>;
    readonly log: (line: string) => void;
    // One upload's cap in bytes; MAX_WRITE_BYTES (files.ts) unless a test sets it lower.
    readonly writeCap?: number;
}

export interface LocalFilesServer {
    readonly fetch: (request: Request, port: number) => Promise<Response>;
    // Drops what a revoked grant held: its cached handlers and its office editor.
    readonly forget: (grant: Grant) => Promise<void>;
}

const HOSTS = [`127.0.0.1`, `localhost`, `[::1]`];

const HEALTH = `GET /health` satisfies RawRouteKey;

// The answer to a browser's preflight from one of the app's pages: what it may send, and for how long it may cache that.
const preflightAnswer = (request: Request, cors: Readonly<Record<string, string>>): Response => {
    const headers = new Headers(cors);
    headers.set(`access-control-allow-methods`, `GET, POST, PUT, DELETE, OPTIONS`);
    headers.set(`access-control-allow-headers`, request.headers.get(`access-control-request-headers`) ?? ``);
    headers.set(`access-control-max-age`, `600`);
    // A page served from the app asking a loopback port is a private-network request to Chromium.
    if (request.headers.get(`access-control-request-private-network`) === `true`) {
        headers.set(`access-control-allow-private-network`, `true`);
    }
    return new Response(null, { status: 204, headers });
};

const bearerOf = (request: Request): string | undefined => /^Bearer\s+(\S+)$/i.exec(request.headers.get(`authorization`) ?? ``)?.[1];

export const createLocalFilesServer = (deps: ServerDeps): LocalFilesServer => {
    const handlers = new Map<string, (request: Request, url: URL) => Promise<Response>>();

    const folderOf = (grant: Grant): LocalFolder => ({
        key: grant.token,
        root: grant.root,
        resolve: async (path) => {
            const resolved = await resolveExisting(grant.root, path);
            return resolved.kind === `found` ? resolved.abs : undefined;
        },
        writable: (path) => {
            const clean = cleanRelPath(path);
            return clean !== undefined && mayWrite(grant, clean);
        },
    });

    const handlerFor = (grant: Grant): ((request: Request, url: URL) => Promise<Response>) => {
        let handler = handlers.get(grant.token);
        if (handler === undefined) {
            const raw = rawFor(grant, deps.office, folderOf(grant), deps.writeCap);
            // What this side answers outside oRPC, the health probe the gates below answer included.
            const rawServed = [HEALTH, ...Object.keys(raw)];
            const procedures = proceduresFor(grant, deps.context, rawServed);
            const served = new Set<string>([...servedProcedures(procedures), ...rawServed]);
            const unserved = Object.fromEntries(
                [...SANDBOX_ROUTE_NAMES, ...RAW_ROUTE_LIST.map((route) => route.name)].filter((name) => !served.has(name)).map((name) => [name, NO_SANDBOX]),
            );
            handler = serve(procedures, raw, unserved, { speaker: `This folder view`, tag: `[local-files]`, log: deps.log });
            handlers.set(grant.token, handler);
        }
        return handler;
    };

    // The CORS answer for an origin the app owns; a request with no Origin (the app's own process) needs none.
    const corsFor = (origin: string | null): Record<string, string> =>
        origin === null ? {} : { "access-control-allow-origin": origin, vary: `Origin`, "access-control-expose-headers": `ETag, Content-Length` };

    const withHeaders = (response: Response, headers: Record<string, string>): Response => {
        for (const [name, value] of Object.entries(headers)) {
            response.headers.set(name, value);
        }
        return response;
    };

    return {
        fetch: async (request, port) => {
            const url = new URL(request.url);
            if (!HOSTS.some((host) => request.headers.get(`host`) === `${host}:${port}`)) {
                return json({ error: `wrong host` }, 421);
            }
            const origin = request.headers.get(`origin`);
            if (origin !== null && !deps.origins.has(origin)) {
                return json({ error: `not this app's page` }, 403);
            }
            const cors = corsFor(origin);
            if (request.method === `OPTIONS`) {
                return preflightAnswer(request, cors);
            }
            // The one door with no credential, as the daemon's: whoever probes it learns only that something answers.
            if (request.method === `GET` && url.pathname === `/health`) {
                return withHeaders(json({ ok: true }), cors);
            }
            const token = bearerOf(request);
            const grant = token === undefined ? undefined : deps.grants.byToken(token);
            if (grant === undefined) {
                return withHeaders(json({ error: `this window no longer has that folder open` }, 401), cors);
            }
            try {
                return withHeaders(await handlerFor(grant)(request, url), cors);
            } catch (error) {
                deps.log(`${request.method} ${url.pathname} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
                return withHeaders(json({ error: `internal` }, 500), cors);
            }
        },
        forget: async (grant) => {
            handlers.delete(grant.token);
            await deps.office.release(grant.token);
        },
    };
};
