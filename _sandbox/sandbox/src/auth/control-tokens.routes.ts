import type { Context } from "hono";
import type { Services } from "../composition.js";
import type { AppEnv } from "../context.js";
import { CONTROL_SCOPES, type ControlScope } from "./control-tokens.js";
import { ownerDenied } from "./owner-gates.js";

/* Control tokens, owner-minted (the sync-pair trust model, made durable + revocable), raw value returned
 * exactly once. What each scope reaches is auth/control-tokens.ts. Plain routes before the oRPC catch-all,
 * like the pair block.
 *
 * The scope is REQUIRED rather than defaulted: every default here is wrong for somebody, and a mint that
 * quietly picks the narrowest one produces a token that 403s on the caller's first real call, while a
 * mint that picks a generous one hands out more reach than was asked for. Making the caller say it is one
 * extra field and no ambiguity.
 *
 * The expiry is OPTIONAL and absent means never: the mint card offers the choice, and the daemon records
 * whichever was made rather than imposing one, because the same token shape serves an editor on the owner's
 * own laptop (revoked when the laptop is) and a CI secret (which should die on its own). */

export type ControlTokenRoutesDeps = Pick<Services, "auth" | "controlTokens">;

type MintRequest = { readonly label: string; readonly scope: ControlScope; readonly expiresAt?: number } | { readonly error: string };

// A usable expiry is a finite epoch-ms instant still ahead of now; anything else asks for a token that could
// never authorize a call.
const futureInstant = (value: unknown, now: number): value is number => typeof value === "number" && Number.isFinite(value) && value > now;

const labelOf = (value: unknown, fallback: string): string => (typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 60) : fallback);

// The mint body, checked field by field: a scope off the ladder and an expiry in the past are the two ways a
// caller can ask for a token that could never work, and both are refused before anything is stored.
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
        // The minter's identity is what the middleware verified for THIS request, never a field of the body.
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
