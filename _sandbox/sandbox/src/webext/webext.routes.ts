import {
    type WebExtSecretAnswer,
    WebExtSecretRequestSchema,
    WebExtSessionExportSchema,
    WebExtSessionImportSchema,
} from "@intentic/sandbox-contract/schemas/webext";
import type { Context } from "hono";
import type { Services } from "../composition.js";
import { bearerPeer } from "../peers/peer-store.js";
import { ticketTag } from "./secret-tickets.js";
import { exportBrowserSession } from "./session-export.js";
import { importBrowserSession } from "./session-import.js";
import { defineRawRoutes } from "../http/raw-route-server.js";

// The credential doors of a connected browser (see also webext-peer.ts): `/system/webext/session` is where a
// handed-over site session arrives; `/system/webext/lend` is the same door outbound, collecting a sandbox account's
// session to lend to the person's own browser; `/system/webext/secret` hands over one stored secret for a ticket the
// daemon gave that browser to type. All authenticate with the extension's own enrollment token as a bearer.

// Authenticated by the extension's own enrollment token as a bearer, so only an extension the owner paired can post
// here; the payload is never logged and the answer never quotes it.
export type WebExtRoutesDeps = Pick<Services, "webexts" | "workspace" | "capabilities" | "logger">;

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

// A browser's credential doors: `session` moves a site sign-in in, `lend` moves one back out, `secret` hands it one stored
// secret to type for a ticket the daemon gave it (secret-tickets.ts).
export const webextRawRoutes = defineRawRoutes((services: WebExtRoutesDeps & Pick<Services, "secretTickets">) => ({
    "POST /system/webext/session": createWebExtSessionRoute(services),
    "POST /system/webext/lend": createWebExtLendRoute(services),
    "POST /system/webext/secret": createWebExtSecretRoute(services),
}));
