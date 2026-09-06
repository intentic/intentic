import { type EnrollHostInput, EnrollHostInputSchema } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import type { Context } from "hono";
import { tokenEquals } from "../auth/auth.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { enrollHost } from "./enroll-host.js";

// POST /enroll. Deploy-target enrollment from the connect-host script (curl, not a browser): authenticated by
// the connect token alone (exempt from the bearer middleware in app.ts), so it self-registers a host without a
// Google login. Loopback mode (no services.auth) accepts any caller, like every other route.
export const createEnrollRoute =
    (services: Services) =>
    async (c: Context<AppEnv>): Promise<Response> => {
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
    };
