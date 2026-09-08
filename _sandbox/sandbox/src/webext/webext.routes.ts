import { WebExtSessionExportSchema, WebExtSessionImportSchema } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { bearerFrom } from "../auth/auth.js";
import type { Services } from "../composition.js";
import { exportBrowserSession } from "./session-export.js";
import { importBrowserSession } from "./session-import.js";

// The two credential doors of a connected browser (see also webext-peer.ts): `/system/webext/session` is where a
// handed-over site session arrives; `/system/webext/lend` is the same door outbound, collecting a sandbox account's
// session to lend to the person's own browser. Both authenticate with the extension's own enrollment token as a bearer.

// Authenticated by the extension's own enrollment token as a bearer, so only an extension the owner paired can post
// here; the payload is never logged and the answer never quotes it.
export type WebExtRoutesDeps = Pick<Services, "webexts" | "workspace" | "capabilities" | "logger">;

export const createWebExtSessionRoute =
    (services: WebExtRoutesDeps) =>
    async (c: Context): Promise<Response> => {
        const id = await services.webexts.verify(bearerFrom(c.req.header("authorization")) ?? "");
        if (id === undefined) {
            return c.json({ error: "unauthorized" }, 401);
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
export const createWebExtLendRoute =
    (services: WebExtRoutesDeps) =>
    async (c: Context): Promise<Response> => {
        const id = await services.webexts.verify(bearerFrom(c.req.header("authorization")) ?? "");
        if (id === undefined) {
            return c.json({ error: "unauthorized" }, 401);
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
