import { CONNECT_TOKEN_HEADER, type EnrollCodeAnswer, EnrollCodeRequestSchema, type EnrollHostInput, EnrollHostInputSchema } from "@intentic/sandbox-contract";
import { ManagedRegionError } from "@intentic/scaffold";
import { ORPCError } from "@orpc/server";
import type { Context } from "hono";
import { tokenEquals } from "../auth/auth.js";
import { ownershipDenied } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { enrollHost } from "./enroll-host.js";

// POST /enroll. Deploy-target enrollment from the connect-host script (curl, not a browser): authenticated by
// the connect token alone (a door in the contract's RAW_ROUTES), so it self-registers a host without a
// Google login. Loopback mode (no services.auth) accepts any caller, like every other route.
// A daemon with auth on and no connect token (allowed when it has a public URL) enrolls nobody: `tokenEquals("", "")`
// is true, so comparing an absent header against an empty token would hand this door to anyone who can reach it.
// The same header may instead carry a SINGLE-USE enroll token (POST /system/enroll/code below), good for this door
// alone and spent by the enrollment it admits; a failed enrollment leaves it for a retry until it expires.
export const createEnrollRoute =
    (services: Services, enroll: typeof enrollHost = enrollHost) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const presented = c.req.header(CONNECT_TOKEN_HEADER) ?? "";
        const expected = services.config.connectToken;
        const singleUse = presented !== "" && services.enrollTokens.peek(presented) !== undefined;
        if (services.auth !== undefined && !singleUse && (expected === "" || !tokenEquals(presented, expected))) {
            return c.json({ error: "unauthorized" }, 401);
        }
        let input: EnrollHostInput;
        try {
            input = EnrollHostInputSchema.parse(await c.req.json());
        } catch {
            return c.json({ error: "invalid enrollment body" }, 400);
        }
        try {
            await enroll(services, input);
        } catch (error) {
            if (error instanceof ORPCError && error.code === "PRECONDITION_FAILED") {
                return c.json({ error: error.message }, 412);
            }
            if (error instanceof ManagedRegionError) {
                return c.json({ error: error.message }, 409);
            }
            throw error;
        }
        if (singleUse) {
            await services.enrollTokens.consume(presented);
        }
        return c.json({ ok: true });
    };

// POST /system/enroll/code: the owner mints a server-connect code. Behind it is a single-use enroll token (pairing TTL),
// so the command that connects a server carries neither the long-lived connect token nor any Cloudflare token: the
// script redeems the code at /system/redeem/<code> for this sandbox's URL, its zone and that token.
export const createEnrollCodeRoute =
    (services: Services) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownershipDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        if (services.config.sandbox.publicUrl === "") {
            return c.json({ error: "this sandbox has no public address for a server to reach it at" }, 412);
        }
        // allow(silent-catch): no body (or none that parses as JSON) is the request without options, as before.
        const raw: unknown = await c.req.json().catch(() => undefined);
        const body = raw === undefined ? {} : EnrollCodeRequestSchema.safeParse(raw).data;
        if (body === undefined) {
            return c.json({ error: "invalid server name" }, 400);
        }
        const { token, expiresIn } = services.enrollTokens.mint({ hostName: body.hostName });
        const code = services.redeemCodes.mint({ kind: "server", connectToken: token, hostName: body.hostName }, expiresIn);
        const answer: EnrollCodeAnswer = { code, expiresIn };
        return c.json(answer);
    };
