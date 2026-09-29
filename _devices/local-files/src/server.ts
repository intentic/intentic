import { randomUUID } from "node:crypto";
import { json, serve, servedProcedures } from "@intentic/contract-serve";
import type { LocalFolder, LocalOffice } from "@intentic/ext-onlyoffice/local-office";
import { RAW_ROUTE_LIST, type RawRouteKey, SANDBOX_ROUTE_NAMES, sandboxRouteFor } from "@intentic/sandbox-contract";
import { type Grant, type Grants, isHandoff, mayWrite } from "./grants.js";
import { cleanRelPath, resolveExisting } from "./paths.js";
import { type ProcedureContext, proceduresFor } from "./procedures.js";
import { rawFor } from "./raw.js";

// The HTTP face every window's editor talks to, on loopback only. Three gates stand before any route, because a
// loopback port is reachable by every web page the user has open, not only by the app: the Host header must name this
// port (a DNS-rebound page names its own host), a page's Origin must be one of the app's own, and the bearer must be a
// token the app granted, which decides the folder. Nothing a page sends can name a folder by itself. A handoff grant is
// the one opening in the second gate: a page of an origin it lists (the web app at its own address) may read that one
// document's bytes with its token, and nothing else, and no page of the app's own may use that token.

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
    readonly writeCap?: number | undefined;
}

export interface LocalFilesServer {
    readonly fetch: (request: Request, port: number) => Promise<Response>;
    // Drops what a grant that ended held (revoked, expired, or replaced under its token): its handlers and office editor.
    readonly forget: (grant: Grant) => Promise<void>;
}

const HOSTS = [`127.0.0.1`, `localhost`, `[::1]`];

// Routes whose answer waits on work longer than a connection may sit idle: a rendering (up to two minutes), the app
// moving something to the trash (as long again), a copy as large as the disk. The process serving them lifts the idle
// bound for these alone (cli.ts), so the answer is still there to send when the work ends.
const UNHURRIED = new Set([`workspace.derive`, `workspace.copy`, `workspace.move`, `workspace.mkdir`, `workspace.delete`]);

export const unhurried = (request: Request): boolean => UNHURRIED.has(sandboxRouteFor(request.method, new URL(request.url).pathname)?.name ?? ``);

const HEALTH = `GET /health` satisfies RawRouteKey;

// What a page of another origin may ask of a handoff grant, and the one route that answers it.
const HANDOFF_METHODS = `GET, HEAD, OPTIONS`;
const HANDOFF_ONLY = `this page may read only the document it was handed`;

// The answer to a browser's preflight from a page this side answers: what it may send, and for how long it may cache
// that. A preflight carries no bearer, so a handoff origin is let through on the strength of a live grant listing it.
const preflightAnswer = (request: Request, cors: Readonly<Record<string, string>>, methods: string): Response => {
    const headers = new Headers(cors);
    headers.set(`access-control-allow-methods`, methods);
    headers.set(`access-control-allow-headers`, request.headers.get(`access-control-request-headers`) ?? ``);
    headers.set(`access-control-max-age`, `600`);
    // A page served from the app (or the web app) asking a loopback port is a private-network request to Chromium.
    if (request.headers.get(`access-control-request-private-network`) === `true`) {
        headers.set(`access-control-allow-private-network`, `true`);
    }
    return new Response(null, { status: 204, headers });
};

const bearerOf = (request: Request): string | undefined => /^Bearer\s+(\S+)$/i.exec(request.headers.get(`authorization`) ?? ``)?.[1];

// Whether a handoff grant's page asked for the one thing it may: its document's bytes, from one of its origins.
const handoffAllows = (grant: Grant, request: Request, url: URL): boolean => {
    const origin = request.headers.get(`origin`);
    return (
        origin !== null &&
        grant.origins?.includes(origin) === true &&
        (request.method === `GET` || request.method === `HEAD`) &&
        url.pathname === `/workspace/raw` &&
        grant.file !== undefined &&
        cleanRelPath(url.searchParams.get(`path`) ?? ``) === grant.file
    );
};

export const createLocalFilesServer = (deps: ServerDeps): LocalFilesServer => {
    // What each grant holds, its handlers and its office editor, by a key of the grant's own rather than its token: a
    // grant that replaces another under the same token starts afresh, never with the folder or rights of the one before.
    const keys = new WeakMap<Grant, string>();
    const keyOf = (grant: Grant): string => {
        const key = keys.get(grant) ?? randomUUID();
        keys.set(grant, key);
        return key;
    };
    const handlers = new Map<string, (request: Request, url: URL) => Promise<Response>>();

    const folderOf = (grant: Grant): LocalFolder => ({
        key: keyOf(grant),
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
        let handler = handlers.get(keyOf(grant));
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
            handlers.set(keyOf(grant), handler);
        }
        return handler;
    };

    // The CORS answer for an origin this side answers; a request with no Origin (the app's own process) needs none.
    const corsFor = (origin: string | null): Record<string, string> =>
        origin === null ? {} : { "access-control-allow-origin": origin, vary: `Origin`, "access-control-expose-headers": `ETag, Content-Length` };

    const withHeaders = (response: Response, headers: Record<string, string>): Response => {
        for (const [name, value] of Object.entries(headers)) {
            response.headers.set(name, value);
        }
        return response;
    };

    // Why a granted token is not answered for this request: a handoff grant outside the one read it allows, or an app
    // window's grant presented by a page of another origin.
    const refusalFor = (grant: Grant, request: Request, url: URL): string | undefined => {
        if (isHandoff(grant)) {
            return handoffAllows(grant, request, url) ? undefined : HANDOFF_ONLY;
        }
        const origin = request.headers.get(`origin`);
        return origin === null || deps.origins.has(origin) ? undefined : `not this app's page`;
    };

    return {
        fetch: async (request, port) => {
            const url = new URL(request.url);
            if (!HOSTS.some((host) => request.headers.get(`host`) === `${host}:${port}`)) {
                return json({ error: `wrong host` }, 421);
            }
            const origin = request.headers.get(`origin`);
            const handedTo = origin !== null && !deps.origins.has(origin) && deps.grants.handoffOrigins().has(origin);
            if (origin !== null && !deps.origins.has(origin) && !handedTo) {
                return json({ error: `not this app's page` }, 403);
            }
            const cors = corsFor(origin);
            if (request.method === `OPTIONS`) {
                return preflightAnswer(request, cors, handedTo ? HANDOFF_METHODS : `GET, POST, PUT, DELETE, OPTIONS`);
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
            const refused = refusalFor(grant, request, url);
            if (refused !== undefined) {
                return withHeaders(json({ error: refused }, 403), cors);
            }
            try {
                return withHeaders(await handlerFor(grant)(request, url), cors);
            } catch (error) {
                deps.log(`${request.method} ${url.pathname} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
                return withHeaders(json({ error: `internal` }, 500), cors);
            }
        },
        forget: async (grant) => {
            handlers.delete(keyOf(grant));
            await deps.office.release(keyOf(grant));
        },
    };
};
