import type { Context } from "hono";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { CONTROL_SCOPES, type ControlScope } from "./control-tokens.js";
import { ownerDenied } from "./owner-gates.js";

// Control tokens, owner-minted, durable and revocable; raw value returned exactly once. Plain routes before the oRPC
// catch-all.
// Scope is required, never defaulted: a narrow default 403s the caller's first call, a generous one over-grants.
// Expiry is optional and absent means never, since the same shape serves both a laptop-bound editor token and a
// self-expiring CI secret.

export type ControlTokenRoutesDeps = Pick<Services, "auth" | "controlTokens">;

type MintRequest = { readonly label: string; readonly scope: ControlScope; readonly expiresAt?: number } | { readonly error: string };

// A usable expiry is a finite epoch-ms instant still ahead of now; anything else could never authorize a call.
const futureInstant = (value: unknown, now: number): value is number => typeof value === "number" && Number.isFinite(value) && value > now;

const labelOf = (value: unknown, fallback: string): string => (typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 60) : fallback);

// The mint body, checked field by field: a bad scope or a past expiry both ask for a token that could never work.
// Refused before anything is stored.
const parseMint = (body: unknown, now: number): MintRequest => {
    const fields = typeof body === "object" && body !== null ? (body as { label?: unknown; scope?: unknown; expiresAt?: unknown }) : {};
    const scope = CONTROL_SCOPES.find((candidate) => candidate === fields.scope);
    if (scope === undefined) {
        return { error: `scope must be one of: ${CONTROL_SCOPES.join(", ")}` };
    }
    if (fields.expiresAt !== undefined && !futureInstant(fields.expiresAt, now)) {
        return { error: "expiresAt must be a future time in epoch milliseconds, or absent for a token that lives until revoked" };
    }
    return { label: labelOf(fields.label, scope), scope, ...(futureInstant(fields.expiresAt, now) ? { expiresAt: fields.expiresAt } : {}) };
};

export const createControlTokenRoutes = (services: ControlTokenRoutesDeps) => ({
    /** POST /system/control/tokens */
    mint: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        const request = parseMint(await c.req.json().catch(() => undefined), Date.now());
        if ("error" in request) {
            return c.json({ error: request.error }, 400);
        }
        // The minter's identity is what the middleware verified for this request, never a field of the body.
        const createdBy = c.get("identity")?.email;
        return c.json(
            await services.controlTokens.mint(request.label, request.scope, {
                ...(createdBy !== undefined ? { createdBy } : {}),
                ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
            }),
        );
    },
    /** GET /system/control/tokens */
    list: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        return c.json({ tokens: await services.controlTokens.list() });
    },
    /** DELETE /system/control/tokens/:id */
    revoke: async (c: Context<AppEnv, "/system/control/tokens/:id">): Promise<Response> => {
        const denied = await ownerDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        return (await services.controlTokens.revoke(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "no such token" }, 404);
    },
});
