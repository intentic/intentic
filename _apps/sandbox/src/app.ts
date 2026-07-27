import { join } from "node:path";
import { type EnrollHostInput, EnrollHostInputSchema } from "@intentic/sandbox-contract";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError } from "@orpc/server";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { bearerFrom, ForbiddenError, tokenEquals } from "./auth/auth.js";
import { bridgeScoped } from "./auth/bridge-tokens.js";
import { streamAgent } from "./agent/agent.routes.js";
import { fireAutomation, PAYLOAD_MAX } from "./automations/scheduler.js";
import { extensionDir, extensionRootOf, readExtensionManifest } from "./capabilities/extension-dirs.js";
import type { Services } from "./composition.js";
import { type AppEnv, buildOrpcContext } from "./context.js";
import { enrollHost } from "./inventory/enroll-host.js";
import { createRouter } from "./router.js";
import {
    clearAllEnrollments,
    consumePairing,
    enrollSyncKey,
    isKeyEnrolled,
    isValidAuthorizedKey,
    isValidPairing,
    mintPairing,
    mirrorMachines,
    pairingMode,
    revokeEnrollmentByToken,
    type SyncMode,
    syncHolder,
    syncSshHostname,
    verifySyncToken,
} from "./platform/sync.js";
import { approveEnvironment, readEnvironment, rejectEnvironment } from "./environment/environment.js";
import { createListenerRoutes } from "./extensions/listener.routes.js";
import { createBrowserLoginRoute } from "./browser/browser-login.js";
import { createTerminalRoute } from "./terminal/terminal.js";
import { createWebchatRoute } from "./webchat/webchat.routes.js";
import { extractTarToWorkspace, PathEscapeError } from "./workspace/workspace-archive.js";
import { computeUploadSkip, type UploadManifestEntry } from "./workspace/workspace-diff.js";
import {
    contentTypeForPath,
    isControlPlanePath,
    MAX_RAW_BYTES,
    MAX_UPLOAD_BYTES,
    resolveWithin,
    sha256Text,
    UploadTooLargeError,
} from "./workspace/workspace-files.js";

// Only genuine server faults (5xx) are logged; expected ORPCErrors (NOT_FOUND/BAD_REQUEST/…) are the routes'
// normal control flow and would be noise.
const logUnexpectedError = (services: Services, error: unknown): void => {
    if (error instanceof ORPCError && error.code !== "INTERNAL_SERVER_ERROR") {
        return;
    }
    services.logger.error({ err: error instanceof Error ? error : new Error(String(error)) }, "unhandled error");
};

// The webhook fire route for event automations — its callers are external systems, so it's exempt from the
// bearer middleware and authenticated by the automation's own token instead (see the route).
const eventFirePath = /^\/automations\/[^/]+\/fire$/;

// The web-chat widget ingest — its callers are anonymous website visitors (no Google token), so it's exempt
// from the bearer middleware and gated by the automation's origin allowlist + rate limit instead (see the route).
const webchatPath = /^\/webchat\/[^/]+\/message$/;

// The only routes the in-container agent token opens: the live VPN surface the `vpn` CLI drives. Anchored and
// path-segment aware so it admits /vpn and /vpn/<id>/connect but never a route that merely starts with those
// characters — the token must not become a general-purpose daemon key.
const vpnScoped = (path: string): boolean => path === "/vpn" || path.startsWith("/vpn/");

// The lowercased email in a member-management request body, or undefined when absent/malformed.
const memberEmail = async (c: Context): Promise<string | undefined> => {
    const body = (await c.req.json().catch(() => undefined)) as { email?: unknown } | undefined;
    return typeof body?.email === "string" ? body.email.toLowerCase() : undefined;
};

// The HTTP API the browser drives DIRECTLY over the sandbox's own Cloudflare tunnel. When services.auth is set
// the daemon verifies the owner's Google ID token on every route but /health (it owns its own auth). No auth
// only in tests or the host-internal server preview. All routes are oRPC except the plain /health and binary
// /workspace/raw, registered before the catch-all.
export const createApp = (services: Services): Hono<AppEnv> => {
    const orpcHandler = new OpenAPIHandler(createRouter(services), {
        interceptors: [
            async (options) => {
                try {
                    return await options.next();
                } catch (error) {
                    // A client that vanished mid-request (tab closed, a cancelled query, a dropped tunnel hop) leaves
                    // the node request stream aborted, and node-server's fast path rejects a read on a disturbed
                    // stream — so oRPC's input decode throws `TypeError: Body is unusable`. Not an incident: oRPC
                    // downgrades it to a 400 that goes to a socket nobody is holding. The window is real because the
                    // bearer middleware awaits `authorize` (JWKS verify + owner read) before the body is ever read,
                    // so every in-flight POST the browser cancels during a busy stretch lands here.
                    if (options.request.signal?.aborted !== true) {
                        logUnexpectedError(services, error);
                    }
                    throw error;
                }
            },
        ],
    });

    const app = new Hono<AppEnv>();

    if (services.auth !== undefined) {
        const authorize = services.auth.authorize;
        const allowOrigin = services.auth.allowOrigin ?? "*";
        app.use(
            "*",
            cors({
                // The daemon is owner-driven from one origin — except the web-chat widget, which is embedded on
                // arbitrary third-party sites. Reflect the caller's origin for /webchat so a legit widget isn't
                // browser-blocked; the route's own allowedOrigins check is the real gate (CORS isn't a security
                // boundary — a non-browser client ignores it).
                origin: (origin, c) => (webchatPath.test(c.req.path) ? (origin ?? "*") : allowOrigin),
                allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
                allowHeaders: ["authorization", "content-type", "x-intentic-connect", "x-intentic-base-hash"],
                maxAge: 600,
            }),
        );
        app.use("*", async (c, next) => {
            // /system/terminal is a WebSocket upgrade: the browser can't set an Authorization header on it, so
            // the terminal route authorizes the token from the query string itself (see createTerminalRoute).
            // /system/authorized-key is redeemed by the desktop-sync agent with a one-time pairing token instead
            // of a bearer; the POST handler checks that token itself and the DELETE handler re-checks the owner.
            if (
                c.req.path === "/health" ||
                c.req.path === "/system/terminal" ||
                // /system/browser-login is a WebSocket upgrade too — it authorizes token+connect from the query
                // string itself (see createBrowserLoginRoute), same as /system/terminal.
                c.req.path === "/system/browser-login" ||
                c.req.path === "/enroll" ||
                c.req.path === "/system/authorized-key" ||
                eventFirePath.test(c.req.path) ||
                webchatPath.test(c.req.path)
            ) {
                return next();
            }
            // An operator panel's own backend (running inside this sandbox) calls the daemon with the per-boot
            // panel token instead of a Google bearer — the token never leaves the container (it's injected into
            // panel processes as INTENTIC_PANEL_TOKEN), so it's server-side only and not a browser-exposed path.
            if (tokenEquals(c.req.header("x-intentic-panel") ?? "", services.panelToken)) {
                return next();
            }
            // The `vpn` CLI on the agent's PATH (and in the owner's own terminals) reaches the daemon over
            // loopback with the per-boot agent token, read from a 0600 file inside the container. Scoped HARD to
            // /vpn: the agent gets to dial and drop the tunnels the owner configured, and nothing else — in
            // particular not /secrets or /capabilities, which would hand it the credentials themselves.
            const agentToken = c.req.header("x-intentic-agent");
            if (agentToken !== undefined && agentToken !== "") {
                if (!vpnScoped(c.req.path)) {
                    return c.json({ error: "agent token not valid for this route" }, 403);
                }
                if (!tokenEquals(agentToken, services.agentToken)) {
                    return c.json({ error: "unauthorized" }, 401);
                }
                return next();
            }
            // The ACP editor bridge (Zed/JetBrains spawn it on the user's machine) presents an owner-minted
            // bridge token instead of a Google bearer. Scope check FIRST and explicit — a bridge hitting an
            // out-of-scope route gets a clear 403, not a baffling missing-bearer 401. Identity stays unset
            // (documented-legal, the panel-token precedent): the bridge acts as the owner's tool, not a member.
            const bridge = c.req.header("x-intentic-bridge");
            if (bridge !== undefined && bridge !== "") {
                if (!bridgeScoped(c.req.method, c.req.path)) {
                    return c.json({ error: "bridge token not valid for this route" }, 403);
                }
                if (!(await services.bridgeTokens.verify(bridge))) {
                    return c.json({ error: "unauthorized" }, 401);
                }
                return next();
            }
            // The desktop-sync agent presents its enrollment-minted token to read the listening-ports list —
            // the ONE route port mirroring needs (`intentic-sync mirror` drives Mutagen forwards from it).
            // Scope check first and explicit, like the bridge: an out-of-scope route is a clear 403.
            const sync = c.req.header("x-intentic-sync");
            if (sync !== undefined && sync !== "") {
                if (c.req.method !== "GET" || c.req.path !== "/ports") {
                    return c.json({ error: "sync token not valid for this route" }, 403);
                }
                if (!(await verifySyncToken(sync))) {
                    return c.json({ error: "unauthorized" }, 401);
                }
                return next();
            }
            try {
                c.set("identity", await authorize(bearerFrom(c.req.header("authorization")), c.req.header("x-intentic-connect") ?? undefined));
            } catch (error) {
                // 403 = verified identity that isn't the owner/a member — the browser renders "no access" for it,
                // distinct from 401 (missing/invalid token), which it treats like any other unreachable daemon.
                if (error instanceof ForbiddenError) {
                    return c.json({ error: error.message }, 403);
                }
                return c.json({ error: "unauthorized" }, 401);
            }
            return next();
        });
    }

    app.get("/health", (c) => c.json({ ok: true }));

    // Raw bytes for any file under /work, with a Content-Type by extension — the browser previews images/PDF
    // here (the text route utf8-decodes and would corrupt them). Same guards/order as workspace.file: 400 on
    // escape, 404 on missing, 413 on oversize.
    app.get("/workspace/raw", async (c) => {
        const path = c.req.query("path");
        const target = path === undefined ? undefined : resolveWithin(services.workspace.root, path);
        if (target === undefined) {
            return c.json({ error: "invalid path" }, 400);
        }
        // The daemon's credential + auth state answers as if it weren't there — no oracle, and no reading the
        // owner's provider token out through the generic file API.
        if (isControlPlanePath(services.workspace.root, target)) {
            return c.json({ error: "not found" }, 404);
        }
        const size = await services.files.size(target);
        if (size === undefined) {
            return c.json({ error: "not found" }, 404);
        }
        if (size > MAX_RAW_BYTES) {
            return c.json({ error: "file too large" }, 413);
        }
        const bytes = await services.files.readBytes(target);
        if (bytes === undefined) {
            return c.json({ error: "not found" }, 404);
        }
        // Wrap in a fresh Uint8Array so the body type is exactly Uint8Array<ArrayBuffer> (a Buffer's backing is
        // ArrayBufferLike, which Hono's body type rejects); bounded by MAX_RAW_BYTES, so the copy is cheap.
        return c.body(new Uint8Array(bytes), 200, { "Content-Type": contentTypeForPath(target), "Content-Length": String(bytes.byteLength) });
    });

    // Write one file under /work — the drag-drop upload AND the editor's text save both post here (bytes / utf8
    // body are the same to persist), so writes stay off oRPC like the raw read above. The body streams straight to
    // disk (no full-buffer), so multi-GB uploads stay flat in memory; parent dirs are auto-created, so a nested
    // dropped-folder path materializes its tree. Guards: 400 on escape, 413 on oversize (Content-Length first,
    // then the running byte count as it streams).
    app.post("/workspace/upload", async (c) => {
        const path = c.req.query("path");
        const target = path === undefined ? undefined : resolveWithin(services.workspace.root, path);
        if (target === undefined) {
            return c.json({ error: "invalid path" }, 400);
        }
        // Same floor as the raw read: the sandbox's owner/members/credential files are not writable through the
        // generic upload, or any member could hand themselves the sandbox by posting a new owner.json.
        if (isControlPlanePath(services.workspace.root, target)) {
            return c.json({ error: "not found" }, 404);
        }
        // A big file arrives as sequential parts (the browser keeps each request under Cloudflare's ~100 MB edge
        // body cap); ?offset says where this part lands, and the write goes in place instead of truncating.
        const offset = Number(c.req.query("offset") ?? 0);
        if (!Number.isInteger(offset) || offset < 0) {
            return c.json({ error: "invalid offset" }, 400);
        }
        const declared = Number(c.req.header("content-length"));
        if (Number.isFinite(declared) && offset + declared > MAX_UPLOAD_BYTES) {
            return c.json({ error: "file too large" }, 413);
        }
        // The editor's guarded save: `x-intentic-base-hash` carries the sha256 of the text the browser last knew
        // on disk (its baseline), and the write is refused when the file no longer matches — an agent or terminal
        // write landed since that read, and a blind overwrite would clobber it. 409 keeps the file untouched; the
        // browser shows its changed-on-disk banner with the user's edits preserved. Drag-drop uploads send no
        // hash and overwrite as before. Check-then-write, not atomic — the guard shrinks the race window from
        // the whole edit session to this handler, which is what the agent needs (its writes echo over the SSE in
        // ~250ms; the guard covers exactly that gap).
        const baseHash = c.req.header("x-intentic-base-hash");
        if (baseHash !== undefined) {
            const current = await services.files.read(target);
            if (current === undefined || sha256Text(current) !== baseHash) {
                return c.json({ error: "the file changed on disk since it was read" }, 409);
            }
        }
        const body = c.req.raw.body;
        // An empty body (a new empty file, or saving an emptied editor buffer) has no stream to pipe. Only at
        // offset 0 — an empty later part must not wipe the parts already written.
        if (body === null) {
            if (offset === 0) {
                await services.files.write(target, "");
            }
        } else {
            try {
                await services.files.writeStream(target, body, MAX_UPLOAD_BYTES, offset);
            } catch (error) {
                if (error instanceof UploadTooLargeError) {
                    return c.json({ error: "file too large" }, 413);
                }
                throw error;
            }
        }
        // A dropped file passes its source mtime as ?mtime so a re-upload can skip it (upload-diff); the editor's
        // text save sends none and keeps the write-time mtime.
        const mtime = Number(c.req.query("mtime"));
        if (Number.isFinite(mtime)) {
            await services.files.setMtime(target, mtime);
        }
        services.history.notifyUserWrite();
        return c.json({ ok: true });
    });

    // Re-upload diff: the client posts a manifest of what it's about to upload (path + source size + mtime) and
    // we answer which paths are already identical on disk (same size + whole-second mtime), so the browser drops
    // those and re-sends only what changed. Live-stats /work (unlike the filtered tree, this sees `.git` and has
    // no entry cap). Read-only — never writes; escaping/denied paths simply aren't reported as skippable.
    app.post("/workspace/upload-diff", async (c) => {
        const { files } = await c.req.json<{ files?: UploadManifestEntry[] }>();
        return c.json({ skip: await computeUploadSkip(services.workspace.root, files ?? []) });
    });

    // Bulk directory upload: the browser streams ONE tar of a large dropped tree here (over per-file POSTs, which
    // cost a round-trip each) and we extract it entry-by-entry into /work. Same guards as the single upload,
    // applied per entry: 400 on any escaping path (aborts), silently skips the daemon's control-plane files
    // (isControlPlanePath), 413 once the running total passes the cap. `.git` IS written — a dropped repo keeps
    // its own, so it stays connected to its remote. Streamed both ways, so a huge tree never lands in memory.
    app.post("/workspace/upload-archive", async (c) => {
        const body = c.req.raw.body;
        if (body === null) {
            return c.json({ error: "empty body" }, 400);
        }
        try {
            await extractTarToWorkspace(services.workspace.root, body, MAX_UPLOAD_BYTES);
        } catch (error) {
            if (error instanceof PathEscapeError) {
                return c.json({ error: "invalid path" }, 400);
            }
            if (error instanceof UploadTooLargeError) {
                return c.json({ error: "file too large" }, 413);
            }
            throw error;
        }
        services.history.notifyUserWrite();
        return c.json({ ok: true });
    });

    // Interactive PTY over a WebSocket. Paired with the `ws` server passed to serve() in main.ts (node-server's
    // upgradeWebSocket drives it); registered before the oRPC catch-all so the upgrade matches here.
    app.get("/system/terminal", createTerminalRoute(services));

    // Guided browser login for `browser`-kind capabilities: a WebSocket that screencasts a live Chromium the
    // owner signs into (see createBrowserLoginRoute). Same shared `ws` server + query-string auth as the terminal.
    app.get("/system/browser-login", createBrowserLoginRoute(services));

    // Deploy-target enrollment from the connect-host script (curl, not a browser): authenticated by the connect
    // token alone (exempt from the bearer middleware above), so it self-registers a host without a Google login.
    // Loopback mode (no services.auth) accepts any caller, like every other route.
    app.post("/enroll", async (c) => {
        if (services.auth !== undefined && !tokenEquals(c.req.header("x-intentic-connect") ?? "", services.config.connectToken)) {
            return c.json({ error: "unauthorized" }, 401);
        }
        let input: EnrollHostInput;
        try {
            input = EnrollHostInputSchema.parse(await c.req.json());
        } catch {
            return c.json({ error: "invalid enrollment body" }, 400);
        }
        try {
            await enrollHost(services, input);
        } catch (error) {
            if (error instanceof ORPCError && error.code === "PRECONDITION_FAILED") {
                return c.json({ error: error.message }, 412);
            }
            throw error;
        }
        return c.json({ ok: true });
    });

    // Webhook fire for event automations: external systems (GitHub/Sentry/monitors) POST here to wake the
    // agent, authenticated by the automation's own token as ?token=… — the only mechanism every webhook sender
    // supports. Enforced ALWAYS (fail-closed even in loopback, unlike /enroll — the token always exists). The
    // body (any format, capped) reaches the guard as AUTOMATION_PAYLOAD and is appended to the wake prompt.
    // Responds immediately; the agent turn runs detached, exactly like a scheduler fire.
    app.post("/automations/:id/fire", async (c) => {
        const automation = await services.automations.get(c.req.param("id"));
        if (automation === undefined || automation.trigger.kind !== "event") {
            return c.json({ error: "no event automation with that id" }, 404);
        }
        const token = automation.trigger.token;
        if (token === undefined || !tokenEquals(c.req.query("token") ?? "", token)) {
            return c.json({ error: "unauthorized" }, 401);
        }
        if (!automation.enabled) {
            return c.json({ error: "automation disabled" }, 409);
        }
        const declared = Number(c.req.header("content-length"));
        if (Number.isFinite(declared) && declared > PAYLOAD_MAX) {
            return c.json({ error: "payload too large" }, 413);
        }
        const payload = await c.req.text();
        void fireAutomation(services, automation, payload === "" ? undefined : payload, streamAgent).catch((error: unknown) =>
            services.logger.error({ err: error, automation: automation.id }, "automation run failed"),
        );
        return c.json({ ok: true });
    });

    // Web-chat widget ingest: an anonymous visitor POSTs a message and the agent's reply streams back as SSE.
    // Exempt from the bearer middleware (visitors have no Google token), gated by the automation's origin
    // allowlist + a per-conversation rate limit. Registered before the oRPC catch-all, like /automations/:id/fire.
    app.post("/webchat/:id/message", createWebchatRoute(services));

    // Owner-only management of the sandbox's shared-access list — the emails the auth check above admits besides
    // the owner. The owner's browser calls these when inviting/removing collaborators; the platform mirrors the
    // grants for discovery, but THIS list is the enforced one. Loopback mode (no auth) skips the owner gate, like
    // every other route. The bearer middleware already ran (caller is at least a member); the owner gate narrows it.
    // Returns the denial response, or undefined when the caller is the owner: 403 for a verified non-owner
    // (ForbiddenError), 401 for authentication failures — the latter matters on the middleware-exempt
    // /system/authorized-key routes, where this gate is the only auth at all.
    const ownerDenied = async (c: Context): Promise<Response | undefined> => {
        if (services.auth === undefined) {
            return undefined;
        }
        try {
            await services.auth.authorizeOwner(bearerFrom(c.req.header("authorization")));
            return undefined;
        } catch (error) {
            return error instanceof ForbiddenError ? c.json({ error: error.message }, 403) : c.json({ error: "unauthorized" }, 401);
        }
    };
    // Whether the caller is the owner (vs a member). Loopback/test mode (no auth) counts as owner. Used to gate
    // what a pairing may grant: the owner can mint a full "sync" pairing, a member only "mirror".
    const isOwner = async (c: Context): Promise<boolean> => (await ownerDenied(c)) === undefined;
    app.get("/members", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        return c.json({ emails: await services.members.list() });
    });
    app.post("/members", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        const email = await memberEmail(c);
        if (email === undefined) {
            return c.json({ error: "email required" }, 400);
        }
        await services.members.add(email);
        return c.json({ emails: await services.members.list() });
    });
    app.delete("/members", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        const email = await memberEmail(c);
        if (email === undefined) {
            return c.json({ error: "email required" }, 400);
        }
        await services.members.remove(email);
        return c.json({ emails: await services.members.list() });
    });

    // The agent-proposed overlay Dockerfile (.intentic/environment.Dockerfile). Members see the state; only the
    // owner approves (copying it to the approved file) or rejects (deleting the proposal). The rebuild itself
    // runs OUTSIDE the container — rebuild.sh locally, the workspace provider on a server — pinned to the
    // approved hash, so approval here never mutates the running sandbox.
    app.get("/environment", async (c) => c.json(await readEnvironment(services)));
    app.post("/environment/approve", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        const body = (await c.req.json().catch(() => undefined)) as { hash?: unknown } | undefined;
        const hash = typeof body?.hash === "string" ? body.hash : undefined;
        if (hash === undefined) {
            return c.json({ error: "hash required" }, 400);
        }
        const failure = await approveEnvironment(services, hash);
        if (failure === "missing") {
            return c.json({ error: "no proposal to approve" }, 404);
        }
        if (failure === "mismatch") {
            return c.json({ error: "the proposal changed since it was reviewed — refresh and re-approve" }, 409);
        }
        if (failure === "invalid") {
            return c.json(
                { error: "the proposal must contain only RUN/ENV content — no FROM (the daemon owns the base image) and no intentic:runtime lines" },
                400,
            );
        }
        return c.json(await readEnvironment(services));
    });
    app.post("/environment/reject", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        await rejectEnvironment(services);
        return c.json(await readEnvironment(services));
    });

    // An installed extension's prebuilt ESM bundle — raw JS bytes, so a plain Hono route like /environment
    // (oRPC is for JSON). The web loader fetches this with auth → Blob URL → import(). ETag = the pinned
    // checkout's HEAD sha: sha-pinned installs make the bundle immutable per commit, so 304s do the caching.
    app.get("/extensions/:id/bundle", async (c) => {
        const id = c.req.param("id");
        const capability = await services.capabilities.get(id);
        if (capability === undefined || capability.kind !== "extension") {
            return c.json({ error: "no extension with that id" }, 404);
        }
        const dir = extensionDir(services.workspace.root, id);
        const extensionRoot = extensionRootOf(dir, capability.config.path);
        const manifest = await readExtensionManifest(extensionRoot);
        if (manifest?.entry === undefined) {
            return c.json({ error: "the extension has no UI entry" }, 404);
        }
        const commit = await services.git.head(dir);
        if (c.req.header("if-none-match") === commit) {
            return c.body(null, 304);
        }
        const source = await services.files.read(join(extensionRoot, manifest.entry));
        if (source === undefined) {
            return c.json({ error: "the entry bundle is missing from the checkout" }, 404);
        }
        return c.body(source, 200, { "content-type": "text/javascript; charset=utf-8", etag: commit });
    });

    // The realtime-listener control surface for an extension's gateway process (ext-discord): it reconciles via
    // /state, POSTs inbound events to /dispatch (holding an ndjson turn-stream when it wants the reply painted),
    // and reports failures/status. Reached with the per-boot panel token (the x-intentic-panel middleware branch
    // above), like every other panel-process call — registered before the oRPC catch-all.
    const listenerRoutes = createListenerRoutes(services);
    app.get("/listeners/:provider/state", listenerRoutes.state);
    app.post("/listeners/:provider/dispatch", listenerRoutes.dispatch);
    app.post("/listeners/:provider/failure", listenerRoutes.failure);
    app.post("/listeners/:provider/status", listenerRoutes.status);

    // Desktop enrollment (Mutagen). The browser mints a short-lived pairing token; the desktop agent redeems it
    // once at /system/authorized-key to land its SSH key — so the agent needs no OAuth, and trust roots in the
    // Google identity that minted the token. The pairing carries the MODE it may enroll: the owner gets full
    // file "sync" (default, or "mirror" on request), a member (collaborator) can only get port "mirror" — so
    // live previews are everyone's while the single-holder file-sync lock stays owner-territory. The route runs
    // through the bearer middleware (not exempt), so an unauthenticated caller is already 401'd here. Sits before
    // the oRPC catch-all, like /members and /workspace/raw.
    app.post("/system/sync/pair", async (c) => {
        const requested = c.req.query("mode") === "mirror" ? "mirror" : "sync";
        const mode: SyncMode = (await isOwner(c)) ? requested : "mirror";
        return c.json({ ...mintPairing(mode), mode });
    });
    // Bridge tokens for the ACP editor bridge — owner-minted (the sync-pair trust model, made durable +
    // revocable), raw value returned exactly once. Plain routes before the oRPC catch-all, like the pair block.
    app.post("/system/bridge/tokens", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        const body = (await c.req.json().catch(() => undefined)) as { label?: unknown } | undefined;
        const label = typeof body?.label === "string" && body.label.trim() !== "" ? body.label.trim().slice(0, 60) : "editor bridge";
        return c.json(await services.bridgeTokens.mint(label));
    });
    app.get("/system/bridge/tokens", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        return c.json({ tokens: await services.bridgeTokens.list() });
    });
    app.delete("/system/bridge/tokens/:id", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        return (await services.bridgeTokens.revoke(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "no such token" }, 404);
    });
    app.post("/system/authorized-key", async (c) => {
        // Authorized either by a valid pairing token (the agent's path) or the owner's Google token (fallback).
        const pair = c.req.header("x-intentic-pair") ?? undefined;
        const viaPair = pair !== undefined && isValidPairing(pair);
        if (!viaPair) {
            const denied = await ownerDenied(c);
            if (denied !== undefined) {
                return denied;
            }
        }
        const body = (await c.req.json().catch(() => undefined)) as { key?: unknown } | undefined;
        const key = typeof body?.key === "string" ? body.key : undefined;
        if (key === undefined || !isValidAuthorizedKey(key)) {
            return c.json({ error: "invalid key" }, 400);
        }
        // The agent needs the tunnel's SSH host to point Mutagen at; without one, sync can't reach this sandbox.
        const sshHostname = syncSshHostname(services.config.connectToken, services.config.zone, services.config.sandbox.publicUrl);
        if (sshHostname === undefined) {
            return c.json({ error: "ssh tunnel not configured" }, 409);
        }
        // The mode comes from the pairing (minted per the requester's role), never from the agent — so a member's
        // pairing can only ever enroll "mirror". The owner-Google fallback path defaults to full "sync".
        const mode: SyncMode = viaPair ? (pairingMode(pair) ?? "mirror") : "sync";
        // A "sync" enroll is single-holder: if a different machine holds it and this isn't a takeover, 423 Locked
        // (before consuming the token, so a retry with --takeover reuses the same pairing). Mirror enrolls never lock.
        const takeover = c.req.header("x-intentic-sync-takeover") === "1";
        const result = await enrollSyncKey({ key, mode, takeover });
        if ("locked" in result) {
            return c.json({ error: "sync already active", machine: result.locked }, 423);
        }
        // Burn the pairing token only on success, so a transient failure leaves it usable for a retry.
        if (pair !== undefined) {
            consumePairing(pair);
        }
        return c.json({ ok: true, sshHostname, syncToken: result.syncToken, mode });
    });
    app.get("/system/sync", async (c) => {
        // Any collaborator (owner or member) may read enrollment state — the bearer middleware already blocked a
        // non-member — so a member's Desktop-sync card can render and mint its mirror-only pairing.
        const sshHostname = syncSshHostname(services.config.connectToken, services.config.zone, services.config.sandbox.publicUrl);
        const holder = await syncHolder();
        const mirrors = await mirrorMachines();
        // Always 200 so the UI can render its "enable" vs "enabled" state; sshHostname is omitted when this
        // sandbox has no SSH tunnel (loopback/preview), which the card treats as "sync unavailable". syncingFrom
        // names the single machine holding file sync (takeover target); mirroredBy lists every machine mirroring
        // ports (unlimited — each collaborator on their own localhost).
        return c.json({
            enrolled: await isKeyEnrolled(),
            ...(holder !== undefined ? { syncingFrom: holder } : {}),
            ...(mirrors.length > 0 ? { mirroredBy: mirrors } : {}),
            ...(sshHostname !== undefined ? { sshHostname } : {}),
        });
    });
    app.delete("/system/authorized-key", async (c) => {
        // Two revoke paths: an agent uninstalling self-revokes with its own sync token (removes just its
        // enrollment); the owner (Google) clears EVERY enrollment — the "Disable desktop sync" kill switch.
        const sync = c.req.header("x-intentic-sync") ?? undefined;
        if (sync !== undefined && sync !== "") {
            return (await revokeEnrollmentByToken(sync)) ? c.json({ ok: true }) : c.json({ error: "unknown enrollment" }, 404);
        }
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        await clearAllEnrollments();
        return c.json({ ok: true });
    });

    // Everything else flows through the oRPC OpenAPI handler, mounted at the root (its contract paths ARE the
    // daemon's routes). Registered last so /health + /workspace/raw match first.
    app.all("/*", async (c) => {
        const result = await orpcHandler.handle(c.req.raw, { context: buildOrpcContext(c) });
        if (result.matched) {
            return result.response;
        }
        return c.notFound();
    });

    return app;
};
