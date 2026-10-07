import { CONNECT_TOKEN_HEADER, type EnrollHostInput, EnrollHostInputSchema } from "@intentic/sandbox-contract";
import { ManagedRegionError } from "@intentic/scaffold";
import { ORPCError } from "@orpc/server";
import type { Context } from "hono";
import { tokenEquals } from "../auth/auth.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { enrollHost } from "./enroll-host.js";

// POST /enroll. Deploy-target enrollment from the connect-host script (curl, not a browser): authenticated by
// the connect token alone (a door in the contract's RAW_ROUTES), so it self-registers a host without a
// Google login. Loopback mode (no services.auth) accepts any caller, like every other route.
// A daemon with auth on and no connect token (allowed when it has a public URL) enrolls nobody: `tokenEquals("", "")`
// is true, so comparing an absent header against an empty token would hand this door to anyone who can reach it.
export const createEnrollRoute =
    (services: Services) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const expected = services.config.connectToken;
        if (services.auth !== undefined && (expected === "" || !tokenEquals(c.req.header(CONNECT_TOKEN_HEADER) ?? "", expected))) {
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
            if (error instanceof ManagedRegionError) {
                return c.json({ error: error.message }, 409);
            }
            throw error;
        }
        return c.json({ ok: true });
    };
