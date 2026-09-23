import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { Readable } from "node:stream";
import type { ExtensionServerApi, ExtensionServerContext } from "@intentic/extension-api";
import { STATE_DIR } from "@intentic/sandbox-contract";
import type { DocsState, OpenRequest, OpenResult } from "../contract.js";
import { documentTypeOf, extensionOf } from "../formats.js";
import { autoStartOf } from "../settings.js";
import { createDockerEngine } from "./docker.js";
import { DocumentServer, IMAGE } from "./document-server.js";
import { editorConfig, hostPage } from "./host-page.js";
import { createListener, type Document } from "./listener.js";
import { Sessions, type Session } from "./sessions.js";

// The backend: three routes for the viewer (/status, /start, /open), a listener of its own for the document server
// and the framed editor page, and the container's lifecycle. Runs inside the daemon's extension host with node
// builtins only.

// Under the workspace state dir: shared across turns and sessions, never tracked, kept across sandbox rebuilds by the volume.
const SECRET_PATH = `${STATE_DIR}/local/onlyoffice/jwt-secret`;

// How the document server reaches this listener from inside its container (the engine's host gateway).
const CONTAINER_TO_SANDBOX = "host.docker.internal";

const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Generated once per workspace, shared with the container as its JWT secret.
const loadSecret = async (file: string): Promise<string> => {
    try {
        const existing = (await readFile(file, "utf8")).trim();
        if (existing !== "") {
            return existing;
        }
    } catch {
        // Absent: minted below.
    }
    await mkdir(posix.dirname(file), { recursive: true });
    const secret = randomBytes(32).toString("hex");
    await writeFile(file, `${secret}\n`, { mode: 0o600 });
    return secret;
};

// How long the document server may sit unused before it is stopped, and how often that is asked. Generous next to the
// browser reaper's ten minutes, because coming back costs an entrypoint restart rather than a page load, and somebody
// reading a long document sends no traffic between saves.
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

const parseOpen = (body: unknown): OpenRequest | undefined => {
    if (typeof body !== "object" || body === null) {
        return undefined;
    }
    const { path, agent, mode, theme } = body as Record<string, unknown>;
    const safe = workspacePath(path);
    if (safe === undefined || (agent !== undefined && typeof agent !== "string") || (mode !== "edit" && mode !== "view")) {
        return undefined;
    }
    return { path: safe, ...(agent === undefined ? {} : { agent }), mode, theme: theme === "dark" ? "dark" : "light" };
};

// Write beside then rename: the watcher and any reader see the old bytes or the new, never a half-written file.
const writeAtomically = async (file: string, bytes: Buffer): Promise<void> => {
    const temporary = `${file}.onlyoffice-${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, file);
};

export const activateServer = async (api: ExtensionServerApi, context: ExtensionServerContext): Promise<void> => {
    const secret = await loadSecret(join(api.workspaceRoot, SECRET_PATH));
    const engine = createDockerEngine();
    const docs = new DocumentServer({ engine, image: IMAGE, secret, log: api.log });
    const sessions = new Sessions();

    // The owner's standing choice: bring the server up with the sandbox rather than on the first document. Read once at
    // boot; a later flip is acted on by the viewer, which starts the server as it saves the setting.
    const settings = await api.daemon.rpc.extensions
        .settings({ id: context.extensionId })
        .catch((error: unknown) => {
            api.log(`settings unreadable, treating auto-start as off: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        });
    if (autoStartOf(settings?.settings)) {
        api.log(`starting the document server with the sandbox (auto-start is on)`);
        void docs.start();
    }

    // Where the browser reaches the listener: the daemon's forwarded-port hostname, asked for again on every open
    // since the forward table is in-memory and a busy sandbox can evict a slot.
    let listenerPort = 0;
    // The last origin the daemon handed out; the listener names it to the document server on every proxied request.
    let publicOrigin: string | undefined;
    const exposure = async (): Promise<string | undefined> => {
        const { previewUrl } = await api.daemon.rpc.ports.forward({ port: listenerPort });
        publicOrigin = previewUrl?.replace(/\/$/, "");
        return publicOrigin;
    };

    const readDocument = async (document: Document): Promise<Readable | undefined> => {
        if (document.agent === undefined) {
            const file = join(api.workspaceRoot, document.path);
            try {
                await stat(file);
            } catch {
                return undefined;
            }
            return createReadStream(file);
        }
        const query = new URLSearchParams({ path: document.path, agent: document.agent });
        const response = await api.daemon.request(`/workspace/raw?${query.toString()}`);
        return response.ok && response.body !== null ? Readable.fromWeb(response.body as never) : undefined;
    };

    const saveDocument = async (key: string, document: Document, url: string): Promise<void> => {
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
        sessions.saved(key, { size: written.size, mtimeMs: written.mtimeMs });
        api.log(`saved ${document.path}`);
    };

    const pageFor = (session: Session): string => {
        const extension = extensionOf(session.path);
        const base = `http://${CONTAINER_TO_SANDBOX}:${listenerPort}`;
        const config = editorConfig({
            session,
            documentType: documentTypeOf(extension) ?? "word",
            fileType: extension,
            title: basename(session.path),
            documentUrl: `${base}/doc/${encodeURIComponent(session.key)}`,
            callbackUrl: `${base}/callback/${encodeURIComponent(session.key)}`,
            secret,
        });
        return hostPage(config, basename(session.path), session.theme);
    };

    const listener = createListener({
        secret,
        sessions,
        documentServerPort: () => docs.running()?.port,
        publicOrigin: () => publicOrigin,
        pageFor,
        readDocument,
        saveDocument,
        log: api.log,
    });
    listenerPort = await listener.listen();
    api.log(`listening on 0.0.0.0:${listenerPort}`);

    // The idle stop. Unref'd so it never holds the sandbox open by itself, and deliberately not cancelled when
    // auto-start is on: auto-start says the server should be there when a document is opened, which `ensureRunning`
    // already guarantees, not that an unused container should hold its memory all day.
    const idleTimer = setInterval(() => void docs.stopIfIdle(IDLE_STOP_MS), IDLE_CHECK_MS);
    idleTimer.unref();

    const open = async (request: OpenRequest): Promise<Response> => {
        if (documentTypeOf(extensionOf(request.path)) === undefined) {
            return json(400, { error: `not an office document: ${request.path}` });
        }
        const state = await docs.ensureRunning();
        if (state.state !== "ready") {
            return json(409, state);
        }
        const origin = await exposure();
        if (origin === undefined) {
            return json(409, { state: "no-address" } satisfies DocsState);
        }
        let fileStat: { size: number; mtimeMs: number } | undefined;
        if (request.agent === undefined) {
            try {
                const found = await stat(join(api.workspaceRoot, request.path));
                fileStat = { size: found.size, mtimeMs: found.mtimeMs };
            } catch {
                return json(404, { error: `no such file: ${request.path}` });
            }
        }
        const session = sessions.open({ path: request.path, agent: request.agent, mode: request.agent === undefined ? request.mode : "view", theme: request.theme, stat: fileStat });
        return json(200, { url: `${origin}/editor?s=${encodeURIComponent(session.token)}` } satisfies OpenResult);
    };

    api.routes.mount(async (request) => {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/status") {
            return json(200, await docs.status());
        }
        if (request.method === "POST" && url.pathname === "/start") {
            return json(200, await docs.start());
        }
        if (request.method === "POST" && url.pathname === "/open") {
            const parsed = parseOpen(await request.json().catch(() => undefined));
            return parsed === undefined ? json(400, { error: "expected { path, mode, theme, agent? }" }) : open(parsed);
        }
        return undefined;
    });
};
