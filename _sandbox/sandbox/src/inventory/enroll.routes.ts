import { CONNECT_TOKEN_HEADER, type EnrollCodeAnswer, EnrollCodeRequestSchema, type EnrollHostInput, EnrollHostInputSchema } from "@intentic/sandbox-contract";
import { hostSshIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { ManagedRegionError } from "@intentic/scaffold";
import { ORPCError } from "@orpc/server";
import type { Context } from "hono";
import { tokenEquals } from "../auth/auth.js";
import { ownershipDenied } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { ownDomainZone } from "../peers/redeem-codes.js";
import { enrollHost } from "./enroll-host.js";

// POST /enroll. Deploy-target enrollment from the connect-host script (curl, not a browser): authenticated by
// the connect token alone (a door in the contract's RAW_ROUTES), so it self-registers a host without a
// Google login. Loopback mode (no services.auth) accepts any caller, like every other route.
// A daemon with auth on and no connect token (allowed when it has a public URL) enrolls nobody: `tokenEquals("", "")`
// is true, so comparing an absent header against an empty token would hand this door to anyone who can reach it.
// The same header may instead carry a SINGLE-USE enroll token (POST /system/enroll/code below), good for this door
// alone, for the server it was minted for alone, and spent by the enrollment it admits; a failed enrollment leaves it
// for a retry until it expires.
export const createEnrollRoute =
    (services: Services, enroll: typeof enrollHost = enrollHost) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const presented = c.req.header(CONNECT_TOKEN_HEADER) ?? "";
        const expected = services.config.connectToken;
        const singleUse = presented === "" ? undefined : services.enrollTokens.peek(presented);
        if (services.auth !== undefined && singleUse === undefined && (expected === "" || !tokenEquals(presented, expected))) {
            return c.json({ error: "unauthorized" }, 401);
        }
        let input: EnrollHostInput;
        try {
            input = EnrollHostInputSchema.parse(await c.req.json());
        } catch {
            return c.json({ error: "invalid enrollment body" }, 400);
        }
        if (singleUse !== undefined) {
            // A token minted for one server enrolls that one: enrolling by name updates a host already there, its key
            // and the Cloudflare token beside it, so a token for a new server must not land on another.
            if (singleUse.hostName !== undefined && singleUse.hostName !== input.name) {
                return c.json({ error: `this enroll token is for the server "${singleUse.hostName}", not "${input.name}"` }, 403);
            }
            // Claimed before the enrollment is awaited: two enrollments presenting one token together must not both
            // find it, so the one that takes it first is the one it admits.
            if (services.enrollTokens.take(presented) === undefined) {
                return c.json({ error: "unauthorized" }, 401);
            }
        }
        try {
            await enroll(services, input);
        } catch (error) {
            if (singleUse !== undefined) {
                services.enrollTokens.restore(presented);
            }
            if (error instanceof ORPCError && error.code === "PRECONDITION_FAILED") {
                return c.json({ error: error.message }, 412);
            }
            if (error instanceof ManagedRegionError) {
                return c.json({ error: error.message }, 409);
            }
            throw error;
        }
        if (singleUse !== undefined) {
            await services.enrollTokens.consume(presented);
        }
        return c.json({ ok: true });
    };

// How long a server code's enroll token lives once the code is redeemed. The code lapses ten minutes after it is
// minted, as every code does, but the script that redeemed it then installs Docker, waits for the person to paste a
// Cloudflare token and pulls the sandbox image before it calls /enroll, which can take far longer than whatever was
// left of those ten minutes.
export const ENROLL_AFTER_REDEEM_MS = 60 * 60 * 1000;

// POST /system/enroll/code: the owner mints a server-connect code. Behind it is a single-use enroll token (pairing TTL,
// then ENROLL_AFTER_REDEEM_MS from the code's redemption), so the command that connects a server carries neither the
// long-lived connect token nor any Cloudflare token: the script redeems the code at /system/redeem/<code> for this
// sandbox's URL, that token and, when the sandbox is on a domain of the owner's own, its zone. And for the server's
// HOST_ID, digested from the long-lived token exactly as before codes (hostSshIdFromToken), so running the command
// again finds the same tunnel, DNS record and Windows container, those of a server connected before codes included.
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
        const zone = ownDomainZone(services.config.sandbox.publicUrl, services.config.ingress.url);
        // No long-lived token, no id: the server then digests one from its single-use token, as before HOST_ID.
        const longLived = services.config.connectToken;
        const hostId = longLived === "" ? undefined : (hostName: string): string => hostSshIdFromToken(longLived, hostName);
        const code = services.redeemCodes.mint({ kind: "server", connectToken: token, hostName: body.hostName, zone, hostId }, expiresIn, {
            onRedeem: () => services.enrollTokens.extend(token, ENROLL_AFTER_REDEEM_MS),
        });
        const answer: EnrollCodeAnswer = { code, expiresIn };
        return c.json(answer);
    };
