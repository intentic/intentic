import {
    WEBEXT_MEDIA_MAX_BYTES,
    WEBEXT_MEDIA_NAME_HEADER,
    WEBEXT_MEDIA_SOURCE_HEADER,
} from "@intentic/sandbox-contract/protocol/doors/webext-links";
import {
    type WebExtFileRefusal,
    WebExtFileRequestSchema,
    type WebExtMediaAnswer,
    type WebExtSecretAnswer,
    WebExtSecretRequestSchema,
    WebExtSessionExportSchema,
    WebExtSessionImportSchema,
} from "@intentic/sandbox-contract/schemas/webext";
import type { Context } from "hono";
import type { Services } from "../composition.js";
import { bearerPeer } from "../peers/peer-store.js";
import { DESCRIBE_TIMEOUT_MS } from "./webext-peer.js";
import { ticketTag } from "./secret-tickets.js";
import { exportBrowserSession } from "./session-export.js";
import { readShelfFile, storeMedia } from "./media-shelf.js";
import { importBrowserSession } from "./session-import.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { readBoundedBytes } from "../http/bounded-body.js";

// The credential doors of a connected browser (see also webext-peer.ts): `/system/webext/session` is where a
// handed-over site session arrives; `/system/webext/lend` is the same door outbound, collecting a sandbox account's
// session to lend to the person's own browser; `/system/webext/secret` hands over one stored secret for a ticket the
// daemon gave that browser to type. All authenticate with the extension's own enrollment token as a bearer.

// Authenticated by the extension's own enrollment token as a bearer, so only an extension the owner paired can post
// here; the payload is never logged and the answer never quotes it.
export type WebExtRoutesDeps = Pick<Services, "webexts" | "workspace" | "capabilities" | "logger" | "webextHub" | "needs">;

const createWebExtSessionRoute =
    (services: WebExtRoutesDeps) =>
    async (c: Context): Promise<Response> => {
        const id = await bearerPeer(services.webexts, c);
        if (typeof id !== "string") {
            return id;
        }
        const parsed = WebExtSessionImportSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ ok: false, message: "That session payload is not one this sandbox can read." }, 400);
        }
        const result = await importBrowserSession(parsed.data, {
            workspaceRoot: services.workspace.root,
            capabilities: await services.capabilities.list(),
        });
        services.logger.info({ browser: id, account: parsed.data.account, ok: result.ok }, "webext: session handed over");
        return c.json(result, result.ok ? 200 : 409);
    };

// Answers with the cookies on this response rather than over the socket, since an MCP result is something the model
// reads; the log line names the account and site, never the jar.
const createWebExtLendRoute =
    (services: WebExtRoutesDeps) =>
    async (c: Context): Promise<Response> => {
        const id = await bearerPeer(services.webexts, c);
        if (typeof id !== "string") {
            return id;
        }
        const parsed = WebExtSessionExportSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ ok: false, message: "That request is not one this sandbox can read." }, 400);
        }
        const result = await exportBrowserSession(parsed.data, {
            workspaceRoot: services.workspace.root,
            capabilities: await services.capabilities.list(),
        });
        services.logger.info(
            { browser: id, account: parsed.data.account, domain: parsed.data.domain, ok: result.ok, cookies: result.cookies?.length ?? 0 },
            "webext: session lent to the owner's browser",
        );
        return c.json(result, result.ok ? 200 : 409);
    };

// The value crosses here and nowhere else: on this answer, to the browser the ticket was minted for, once the caller's
// guard has judged the page the browser named. The bearer says which browser is asking, never the body. Neither the log
// line nor any refusal carries the value; the ticket appears only as its tag.
export const createWebExtSecretRoute =
    (services: Pick<Services, "webexts" | "secretTickets" | "logger">) =>
    async (c: Context): Promise<Response> => {
        const id = await bearerPeer(services.webexts, c);
        if (id instanceof Response) {
            return id;
        }
        // allow(silent-catch): a body that is not JSON is refused just below as a request this door cannot read
        const parsed = WebExtSecretRequestSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ ok: false, message: "That request is not one this sandbox can read." } satisfies WebExtSecretAnswer, 400);
        }
        const redeemed = await services.secretTickets.redeem(id, parsed.data, c.req.raw.signal);
        services.logger.info(
            {
                browser: id,
                ticket: ticketTag(parsed.data.ticket),
                secret: redeemed.secret,
                field: parsed.data.field,
                ok: redeemed.ok,
                ...(redeemed.ok ? { host: redeemed.page.host } : { status: redeemed.status }),
            },
            redeemed.ok ? "webext: a secret handed to the owner's browser to type" : "webext: a secret ticket refused",
        );
        return redeemed.ok
            ? c.json({ ok: true, value: redeemed.value } satisfies WebExtSecretAnswer, 200)
            : c.json({ ok: false, message: redeemed.refusal } satisfies WebExtSecretAnswer, redeemed.status);
    };

// A media type as the extension said it, its parameters dropped; anything not shaped like one is refused below.
const mediaTypeOf = (header: string | undefined): string | undefined => {
    const type = header?.split(";")[0]?.trim().toLowerCase() ?? "";
    return /^[a-z]+\/[a-z0-9.+-]+$/u.test(type) ? type : undefined;
};

// The name the page suggested, as the extension encoded it; one that does not decode is replaced by the shelf's default.
const decodedName = (header: string | undefined): string => {
    try {
        return decodeURIComponent(header ?? "");
        // allow(silent-catch): a malformed escape is a name to replace, and the shelf's default replaces it
    } catch {
        return "";
    }
};

// A picture, video or file the agent saved from a page in the owner's browser (`save_media`, or a download its click
// started), as the raw body: stored on the artifacts shelf under `chrome/` (media-shelf.ts), and answered with where it
// now is, which the extension passes on to the agent. The extension checked the bytes against their type and its own
// cap; this door holds the same cap on its own, since the token, not the extension's build, is what it can trust.
export const createWebExtMediaRoute =
    (services: Pick<Services, "webexts" | "workspace" | "logger">) =>
    async (c: Context): Promise<Response> => {
        const id = await bearerPeer(services.webexts, c);
        if (id instanceof Response) {
            return id;
        }
        const refuse = (status: 400 | 413, message: string): Response => c.json({ ok: false, message } satisfies WebExtMediaAnswer, status);
        const mimeType = mediaTypeOf(c.req.header("content-type"));
        if (mimeType === undefined) {
            return refuse(400, "The file came without a type this sandbox can read, so it was not saved.");
        }
        const read = await readBoundedBytes(c.req.raw, WEBEXT_MEDIA_MAX_BYTES);
        if (read.kind !== "ok") {
            return refuse(413, `The file is larger than the ${WEBEXT_MEDIA_MAX_BYTES / 1_048_576} MB one save can carry, so it was not saved.`);
        }
        const body = read.value;
        if (body.byteLength === 0) {
            return refuse(400, "The file was empty, so nothing was saved.");
        }
        const stored = await storeMedia(services.workspace.root, body, mimeType, decodedName(c.req.header(WEBEXT_MEDIA_NAME_HEADER)));
        // The page's host and what was written, never a word of the content.
        services.logger.info(
            { browser: id, source: c.req.header(WEBEXT_MEDIA_SOURCE_HEADER)?.slice(0, 200), bytes: stored.bytes, mimeType, path: stored.path },
            "webext: media saved from the owner's browser",
        );
        return c.json({ ok: true, path: stored.path, bytes: stored.bytes, mimeType: stored.mimeType } satisfies WebExtMediaAnswer, 200);
    };

// One shelf file handed to the browser for a page's file input, for the ticket the daemon added to the agent's
// `upload_file` call (file-tickets.ts), on that browser's own token. The bytes are the answer's body; the log line names
// the file and the browser, the ticket only by its tag.
export const createWebExtFileRoute =
    (services: Pick<Services, "webexts" | "logger" | "fileTickets">) =>
    async (c: Context): Promise<Response> => {
        const id = await bearerPeer(services.webexts, c);
        if (id instanceof Response) {
            return id;
        }
        // allow(silent-catch): a body that is not JSON is refused just below as a request this door cannot read
        const parsed = WebExtFileRequestSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ ok: false, message: "That request is not one this sandbox can read." } satisfies WebExtFileRefusal, 400);
        }
        const redeemed = await services.fileTickets.redeem(id, parsed.data.ticket);
        services.logger.info(
            { browser: id, ticket: ticketTag(parsed.data.ticket), ok: redeemed.ok, ...(redeemed.ok ? { path: redeemed.path, bytes: redeemed.bytes } : { status: redeemed.status }) },
            redeemed.ok ? "webext: a shelf file handed to the owner's browser to upload" : "webext: a file ticket refused",
        );
        if (!redeemed.ok) {
            return c.json({ ok: false, message: redeemed.refusal } satisfies WebExtFileRefusal, redeemed.status);
        }
        const bytes = await readShelfFile(redeemed);
        return new Response(new Uint8Array(bytes), {
            status: 200,
            headers: {
                "content-type": redeemed.mimeType,
                "content-length": String(bytes.byteLength),
                [WEBEXT_MEDIA_NAME_HEADER]: encodeURIComponent(redeemed.name),
            },
        });
    };

// A site allowed in this browser (its popup or the browser's own site-access menu, 2026-10-20): read its facts now and
// check open needs, so an `ask_access` the person just answered goes on at once rather than on the needs fallback timer.
const createWebExtGrantsChangedRoute =
    (services: Pick<WebExtRoutesDeps, "webexts" | "webextHub" | "needs" | "logger">) =>
    async (c: Context): Promise<Response> => {
        const id = await bearerPeer(services.webexts, c);
        if (typeof id !== "string") {
            return id;
        }
        await services.webextHub.refresh(id, DESCRIBE_TIMEOUT_MS);
        void services.needs.recheck().catch((error: Error) => services.logger.warn({ err: error, browser: id }, "needs: the check after a browser's sites moved failed"));
        return c.json({ ok: true });
    };

// A browser's credential doors: `session` moves a site sign-in in, `lend` moves one back out, `secret` hands it one stored
// secret to type for a ticket the daemon gave it (secret-tickets.ts); `media` stores what it saved from a page and `file`
// hands it one shelf file for a ticket (file-tickets.ts); and `grants-changed`, its allowed sites moving.
export const webextRawRoutes = defineRawRoutes((services: WebExtRoutesDeps & Pick<Services, "secretTickets" | "fileTickets">) => ({
    "POST /system/webext/session": createWebExtSessionRoute(services),
    "POST /system/webext/lend": createWebExtLendRoute(services),
    "POST /system/webext/secret": createWebExtSecretRoute(services),
    "POST /system/webext/grants-changed": createWebExtGrantsChangedRoute(services),
    "POST /system/webext/media": createWebExtMediaRoute(services),
    "POST /system/webext/file": createWebExtFileRoute(services),
}));
