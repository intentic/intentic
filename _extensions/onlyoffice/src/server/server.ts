import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { Readable } from "node:stream";
import type { ExtensionServerApi, ServerActivation } from "@intentic/extension-api";
import { STATE_DIR } from "@intentic/sandbox-contract";
import { ENGINES, type DocsState, type Engine, type OpenRequest, type OpenResult } from "../contract.js";
import { documentTypeOf, extensionOf } from "../formats.js";
import { autoStartOf, engineOf } from "../settings.js";
import { createBrowserEngine } from "./browser-engine.js";
import { BUNDLE_PIN } from "./bundle-pin.js";
import { BundleStore } from "./bundle.js";
import { forceSave } from "./command.js";
import { createDockerEngine } from "./docker.js";
import { DocumentServer, IMAGE } from "./document-server.js";
import { editorConfig, hostPage } from "./host-page.js";
import { createListener, type Document } from "./listener.js";
import { Sessions, type FileStat, type OpenInput, type Session } from "./sessions.js";

// The backend: four routes for the viewer (/status, /start, /open, /forcesave), a listener of its own for the framed
// editor page, and the two engines behind it: the browser engine's bundle (downloaded once, served as files) and the
// document server's container. Runs inside the daemon's extension host with node builtins only.

// In the extension's own state directory (`api.stateDir`): shared across turns and sessions, never tracked, kept across
// sandbox rebuilds by the volume, deleted with the extension.
const SECRET_FILE = "jwt-secret";
// The listener's port from its last run. Taken again when free, so a restarted backend answers at the address the
// browser already knows: the same forwarded origin keeps the editor's service worker cache, and the document server
// keeps reaching the callback address a session it is still holding was opened with.
const PORT_FILE = "listener-port";
// The browser engine's bundle, in the extension's own cache directory (`api.cacheDir`): the watcher ignores it and no
// backup carries it.
const BUNDLE_DIR = "bundle";

// Where each of those lived before the host handed the extension directories of its own, workspace-relative. Moved once
// rather than abandoned: a new secret would recreate the document server's container, and the bundle is a 200 MB
// download.
const LEGACY_STATE = `${STATE_DIR}/local/onlyoffice`;
const LEGACY_BUNDLE = `${STATE_DIR}/local/cache/onlyoffice/bundle`;

// How the document server reaches this listener from inside its container (the engine's host gateway).
const CONTAINER_TO_SANDBOX = "host.docker.internal";

const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A request's JSON body, or undefined for one that does not parse.
const bodyOf = (request: Request): Promise<unknown> =>
    // allow(silent-catch): a body that does not parse is the caller's mistake, which the route answers with a 400 or 404.
    request.json().catch(() => undefined);

// The path, or a directory on the way to it, is not there; any other failure is not "missing".
const isMissing = (error: unknown): boolean => {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
};

// Generated once per workspace, shared with the container as its JWT secret. Only an absent file is minted over: one
// that could not be read would be replaced, and the container holding it recreated.
const loadSecret = async (file: string): Promise<string> => {
    try {
        const existing = (await readFile(file, "utf8")).trim();
        if (existing !== "") {
            return existing;
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }
    await mkdir(posix.dirname(file), { recursive: true });
    const secret = randomBytes(32).toString("hex");
    await writeFile(file, `${secret}\n`, { mode: 0o600 });
    return secret;
};

// The port the listener held last time, or 0 (any) when there is none to read. Costs only the stable address when it
// fails, never the start.
const loadPort = async (file: string, log: (line: string) => void): Promise<number> => {
    let text: string;
    try {
        text = await readFile(file, "utf8");
    } catch (error) {
        if (!isMissing(error)) {
            log(`the listener's last port is unreadable, taking any: ${error instanceof Error ? error.message : String(error)}`);
        }
        return 0;
    }
    const port = Number.parseInt(text.trim(), 10);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
};

// Records the port the listener took, for the next run to take again. Costs only the stable address when it fails.
const recordPort = async (file: string, port: number, log: (line: string) => void): Promise<void> => {
    try {
        await mkdir(posix.dirname(file), { recursive: true });
        await writeFile(file, `${port}\n`);
    } catch (error) {
        log(`could not record the listener's port, the next run takes any: ${error instanceof Error ? error.message : String(error)}`);
    }
};

// How long the document server may sit unused before it is stopped, and how often that is asked. Generous next to the
// browser reaper's ten minutes, because coming back costs an entrypoint restart rather than a page load; an editor
// still open holds it whatever the clock says (the listener counts their sockets).
const IDLE_STOP_MS = 30 * 60_000;
const IDLE_CHECK_MS = 5 * 60_000;

// A workspace-relative path with nothing that escapes the workspace; undefined otherwise.
export const workspacePath = (raw: unknown): string | undefined => {
    if (typeof raw !== "string" || raw === "" || raw.includes("\0")) {
        return undefined;
    }
    const normalized = posix.normalize(raw);
    if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized === ".") {
        return undefined;
    }
    return normalized;
};

// The engine a request names, the browser one for anything else.
export const engineFrom = (engine: unknown): Engine => (ENGINES as readonly unknown[]).includes(engine) ? (engine as Engine) : "browser";

// The request's optional text fields, each kept only when it is a string.
const OPTIONAL_TEXT = ["agent", "resume", "lang", "origin"] as const;

// An open request while it is being assembled.
type OpenRequestDraft = { -readonly [Key in keyof OpenRequest]: OpenRequest[Key] };

export const parseOpen = (body: unknown): OpenRequest | undefined => {
    if (typeof body !== "object" || body === null) {
        return undefined;
    }
    // SAFETY: a JSON body that is an object; each field is checked below before it is used.
    const fields = body as Record<string, unknown>;
    const path = workspacePath(fields["path"]);
    const mode = fields["mode"];
    // A scope or a kept editor that is not a string is a malformed request, not one without them.
    const malformed = ["agent", "resume"].some((key) => fields[key] !== undefined && typeof fields[key] !== "string");
    if (path === undefined || (mode !== "edit" && mode !== "view") || malformed) {
        return undefined;
    }
    const request: OpenRequestDraft = {
        path,
        mode,
        theme: fields["theme"] === "dark" ? "dark" : "light",
        engine: engineFrom(fields["engine"]),
    };
    for (const key of OPTIONAL_TEXT) {
        const value = fields[key];
        if (typeof value === "string") {
            request[key] = value;
        }
    }
    return request;
};

// Write beside then rename: the watcher and any reader see the old bytes or the new, never a half-written file.
const writeAtomically = async (file: string, bytes: Buffer): Promise<void> => {
    const temporary = `${file}.onlyoffice-${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, file);
};

// The owner's standing choice at boot: with auto-start on, the chosen engine is made ready now (the browser engine's
// download, or the document server's container) instead of on the first document. A container the engine already runs
// is adopted either way, so an open on the server engine does not wait on the readiness check.
const prepareAtBoot = (settings: Record<string, unknown> | undefined, deps: { docs: DocumentServer; bundle: BundleStore; log: (line: string) => void }): void => {
    const engine = engineOf(settings);
    if (autoStartOf(settings) && engine === "server") {
        deps.log(`starting the document server with the sandbox (auto-start is on)`);
        void deps.docs.start();
        return;
    }
    void deps.docs.adopt();
    if (autoStartOf(settings)) {
        deps.log(`preparing the browser editor with the sandbox (auto-start is on)`);
        void deps.bundle.ensure();
    }
};

// Moves `from` to `to` when only `from` is there; a move that already happened, or never had anything to move, is done.
const adopt = async (from: string, to: string): Promise<void> => {
    try {
        await stat(to);
        return;
    } catch (error) {
        if (!isMissing(error)) {
            throw error;
        }
    }
    try {
        await mkdir(posix.dirname(to), { recursive: true });
        await rename(from, to);
    } catch (error) {
        if (!isMissing(error)) {
            throw error;
        }
    }
};

// What an earlier version kept outside the extension's own directories, moved into them. Best effort: a move that fails
// costs a fresh secret or a fresh download, never the start.
const adoptLegacyState = async (api: ExtensionServerApi): Promise<void> => {
    const legacy = join(api.workspaceRoot, LEGACY_STATE);
    try {
        await adopt(join(legacy, SECRET_FILE), join(api.stateDir, SECRET_FILE));
        await adopt(join(legacy, PORT_FILE), join(api.stateDir, PORT_FILE));
        await adopt(join(api.workspaceRoot, LEGACY_BUNDLE), join(api.cacheDir, BUNDLE_DIR));
        // allow(silent-catch): the old directory holding something else of its own is reason enough to leave it
        await rmdir(legacy).catch(() => undefined);
    } catch (error) {
        api.log(`what an earlier version kept could not be moved into this extension's own directories: ${error instanceof Error ? error.message : String(error)}`);
    }
};

export const activateServer = async (api: ExtensionServerApi): Promise<ServerActivation> => {
    await adoptLegacyState(api);
    const secret = await loadSecret(join(api.stateDir, SECRET_FILE));
    const engine = createDockerEngine();
    const docs = new DocumentServer({ engine, image: IMAGE, secret, log: api.log });
    const sessions = new Sessions();

    // The owner's standing choice: bring the server up with the sandbox rather than on the first document. Read once at
    // boot; a later flip is acted on by the viewer, which starts the server as it saves the setting. Without it, a
    // container the engine already runs is still adopted, so the first open does not wait on the readiness check.
    const settings = await api.settings.get().catch((error: unknown) => {
        api.log(`settings unreadable, treating auto-start as off: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    });
    const bundle = new BundleStore({ root: join(api.cacheDir, BUNDLE_DIR), pin: BUNDLE_PIN, log: api.log });
    // Reads what is on disk at once, so the first open knows whether the bundle is there.
    void bundle.load().catch((error: unknown) => api.log(`the editor bundle cache is unreadable: ${error instanceof Error ? error.message : String(error)}`));
    prepareAtBoot(settings, { docs, bundle, log: api.log });

    // Where the browser reaches the listener: the daemon's forwarded-port hostname, asked for again on every open
    // since the forward table is in-memory and a busy sandbox can evict a slot.
    let listenerPort = 0;
    const exposure = async (): Promise<string | undefined> => {
        const { previewUrl } = await api.daemon.rpc.ports.forward({ port: listenerPort });
        return previewUrl?.replace(/\/$/, "");
    };

    const scopedRaw = (path: string, agent: string): Promise<Response> =>
        api.daemon.request(`/workspace/raw?${new URLSearchParams({ path, agent }).toString()}`);

    const readDocument = async (document: Document): Promise<Readable | undefined> => {
        if (document.agent === undefined) {
            const file = join(api.workspaceRoot, document.path);
            try {
                await stat(file);
            } catch (error) {
                if (isMissing(error)) {
                    return undefined;
                }
                throw error;
            }
            return createReadStream(file);
        }
        const response = await scopedRaw(document.path, document.agent);
        return response.ok && response.body !== null ? Readable.fromWeb(response.body as never) : undefined;
    };

    // What the bytes of a document are right now, for its key: the stat of a shared-tree file (undefined when it is
    // gone), the digest of a conversation's copy (none when it cannot be read, which keys that open fresh).
    const identify = async (path: string, agent: string | undefined): Promise<{ stat?: FileStat; digest?: string } | undefined> => {
        if (agent === undefined) {
            try {
                const found = await stat(join(api.workspaceRoot, path));
                return { stat: { size: found.size, mtimeMs: found.mtimeMs } };
            } catch (error) {
                if (isMissing(error)) {
                    return undefined;
                }
                throw error;
            }
        }
        const response = await scopedRaw(path, agent);
        if (!response.ok || response.body === null) {
            return {};
        }
        const hash = createHash("sha256");
        for await (const chunk of Readable.fromWeb(response.body as never)) {
            hash.update(chunk as Buffer);
        }
        return { digest: hash.digest("base64url") };
    };

    const saveDocument = async (document: Document, url: string): Promise<FileStat> => {
        if (document.agent !== undefined) {
            throw new Error("a conversation's checkout is read-only here");
        }
        const running = docs.running();
        if (running === undefined) {
            throw new Error("the document server stopped before the save was fetched");
        }
        // The server names its own address in the URL; the loopback port is where it actually answers from here.
        const source = new URL(url);
        source.protocol = "http:";
        source.host = `127.0.0.1:${running.port}`;
        const response = await fetch(source);
        if (!response.ok) {
            throw new Error(`the document server answered ${response.status} for the saved document`);
        }
        const file = join(api.workspaceRoot, document.path);
        await writeAtomically(file, Buffer.from(await response.arrayBuffer()));
        const written = await stat(file);
        api.log(`saved ${document.path}`);
        return { size: written.size, mtimeMs: written.mtimeMs };
    };

    const configFor = (session: Session): Record<string, unknown> => {
        const extension = extensionOf(session.path);
        const base = `http://${CONTAINER_TO_SANDBOX}:${listenerPort}`;
        return editorConfig({
            session,
            documentType: documentTypeOf(extension) ?? "word",
            fileType: extension,
            title: basename(session.path),
            documentUrl: `${base}/doc/${encodeURIComponent(session.key)}`,
            callbackUrl: `${base}/callback/${encodeURIComponent(session.key)}`,
            secret,
        });
    };

    const refresh = async (session: Session): Promise<Record<string, unknown> | undefined> => {
        const identity = await identify(session.path, session.agent);
        if (identity === undefined) {
            return undefined;
        }
        const renewed = sessions.renew(session.token, {
            path: session.path,
            agent: session.agent,
            mode: session.mode,
            theme: session.theme,
            stat: identity.stat,
            digest: identity.digest,
            run: docs.run(),
        });
        return renewed === undefined ? undefined : configFor(renewed);
    };

    const browser = createBrowserEngine({
        workspaceRoot: api.workspaceRoot,
        pageDir: join(api.extensionDir, "dist", "editor"),
        sessions,
        bundle,
        scopedRaw,
        identify,
        exposure,
        log: api.log,
    });

    const listener = createListener({
        secret,
        sessions,
        documentServerPort: () => docs.running()?.port,
        pageFor: (session) => (session.engine === "browser" ? browser.page(session) : hostPage(configFor(session), basename(session.path), session.theme)),
        refresh,
        readDocument,
        saveDocument,
        browser: browser.routes,
        log: api.log,
    });
    const portFile = join(api.stateDir, PORT_FILE);
    const lastPort = await loadPort(portFile, api.log);
    listenerPort = await listener.listen(lastPort);
    if (listenerPort !== lastPort) {
        await recordPort(portFile, listenerPort, api.log);
    }
    api.log(`listening on 0.0.0.0:${listenerPort}`);

    // The idle stop. Unref'd so it never holds the sandbox open by itself, and deliberately not cancelled when
    // auto-start is on: auto-start says the server should be there when a document is opened, which `ensureRunning`
    // already guarantees, not that an unused container should hold its memory all day.
    const idleTimer = setInterval(() => void docs.stopIfIdle(IDLE_STOP_MS, listener.editorsConnected()), IDLE_CHECK_MS);
    idleTimer.unref();

    const open = async (request: OpenRequest): Promise<Response> => {
        if (documentTypeOf(extensionOf(request.path)) === undefined) {
            return json(400, { error: `not an office document: ${request.path}` });
        }
        if (request.engine !== "server") {
            const opened = await browser.open(request);
            return json(opened.status, opened.body);
        }
        const state = await docs.ensureRunning();
        if (state.state !== "ready") {
            return json(409, state);
        }
        const identity = await identify(request.path, request.agent);
        if (identity === undefined) {
            return json(404, { error: `no such file: ${request.path}` });
        }
        const input: OpenInput = {
            path: request.path,
            agent: request.agent,
            mode: request.agent === undefined ? request.mode : "view",
            theme: request.theme,
            stat: identity.stat,
            digest: identity.digest,
            run: docs.run(),
        };
        // The editor the viewer kept alive still holds these bytes, on this run of the server: show it again.
        if (request.resume !== undefined && sessions.current(request.resume, input)) {
            return json(200, { resumed: true } satisfies OpenResult);
        }
        const origin = await exposure();
        if (origin === undefined) {
            return json(409, { state: "no-address" } satisfies DocsState);
        }
        const session = sessions.open(input);
        return json(200, { url: `${origin}/editor?s=${encodeURIComponent(session.token)}`, session: session.token, engine: "server" } satisfies OpenResult);
    };

    // Best effort by design: the viewer fires it as it leaves a document and never waits on the answer.
    const forceSaveSession = async (token: unknown): Promise<Response> => {
        const session = typeof token === "string" ? sessions.session(token) : undefined;
        if (session === undefined) {
            return json(404, { error: "no such session" });
        }
        const running = docs.running();
        if (session.mode !== "edit" || running === undefined) {
            return json(200, { outcome: "unchanged" });
        }
        return json(200, { outcome: await forceSave(running.port, session.key, secret) });
    };

    api.routes.mount(async (request) => {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/status") {
            return json(200, engineFrom(url.searchParams.get("engine")) === "server" ? await docs.status() : await browser.status());
        }
        if (request.method === "POST" && url.pathname === "/start") {
            // SAFETY: a JSON body or undefined; its one field is read through engineFrom, which takes anything.
            const body = (await bodyOf(request)) as { engine?: unknown } | null | undefined;
            const chosen = engineFrom(body?.engine);
            return json(200, chosen === "server" ? await docs.start() : await browser.prepare());
        }
        if (request.method === "POST" && url.pathname === "/open") {
            const parsed = parseOpen(await bodyOf(request));
            return parsed === undefined ? json(400, { error: "expected { path, mode, theme, agent?, resume? }" }) : open(parsed);
        }
        if (request.method === "POST" && url.pathname === "/forcesave") {
            // SAFETY: a JSON body or undefined; its one field is read through forceSaveSession, which takes anything.
            const body = (await bodyOf(request)) as { session?: unknown } | null | undefined;
            return forceSaveSession(body?.session);
        }
        return undefined;
    });

    // Let go of everything this activation opened, so a change to this extension alone reloads it in the running host.
    // The document server's container stays up: the next activation adopts it, and a session still open in a browser
    // reconnects to the same listener port, recorded above.
    return {
        deactivate: async () => {
            clearInterval(idleTimer);
            await listener.close();
        },
    };
};
