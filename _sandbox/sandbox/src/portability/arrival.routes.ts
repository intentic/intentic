import { ArrivalApplySchema, ArrivalScanSchema } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { ArrivalFormatError, ArrivalStaleError } from "../arrival-error.js";
import { ownerDenied } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { MAX_UPLOAD_BYTES, UploadTooLargeError } from "../workspace/files/workspace-files-upload.js";
import { createArrivals } from "./arrival.js";

// Everything arriving at this sandbox (sandbox.toml, an environment bundle, a packed foreign home) through one
// preview-first pipeline, not three routes. Raw Hono handles the arbitrary-size upload stream; owner-only throughout.
// Four calls — plan, scan, apply, delete — and the format is never one of them: the daemon sniffs it from the bytes.

// Two ways a caller can be wrong, told apart: a file that isn't what it claims is 400 with the reader's own message; a
// token that no longer matches is 409, since the file was fine and the preview went stale.
const arrivalFailed = (error: unknown): { readonly error: string; readonly status: 400 | 409 | 413 } | undefined => {
    if (error instanceof ArrivalStaleError) {
        return { error: error.message, status: 409 };
    }
    if (error instanceof ArrivalFormatError) {
        return { error: error.message, status: 400 };
    }
    return error instanceof UploadTooLargeError ? { error: "that arrival is too large", status: 413 } : undefined;
};

export const createArrivalRoutes = (services: Services) => {
    const arrivals = createArrivals(services);
    return {
        /** POST /arrivals/plan */
        plan: async (c: Context<AppEnv>): Promise<Response> => {
            const denied = await ownerDenied(services, c);
            if (denied !== undefined) {
                return denied;
            }
            const body = c.req.raw.body;
            if (body === null) {
                return c.json({ error: "empty body" }, 400);
            }
            try {
                return c.json(await arrivals.plan(body, MAX_UPLOAD_BYTES));
            } catch (error) {
                const failed = arrivalFailed(error);
                if (failed === undefined) {
                    throw error;
                }
                return c.json({ error: failed.error }, failed.status);
            }
        },
        // Owner's own devices as arrival sources, probed live so the offer appears before they read a packing
        // instruction. Never fails the card: a probe's own failure becomes that row's `detail`.
        hosts: async (c: Context<AppEnv>): Promise<Response> => {
            const denied = await ownerDenied(services, c);
            if (denied !== undefined) {
                return denied;
            }
            return c.json({ hosts: await arrivals.hosts() });
        },
        /** POST /arrivals/scan */
        scan: async (c: Context<AppEnv>): Promise<Response> => {
            const denied = await ownerDenied(services, c);
            if (denied !== undefined) {
                return denied;
            }
            const parsed = ArrivalScanSchema.safeParse(await c.req.json().catch(() => undefined));
            if (!parsed.success) {
                return c.json({ error: "expected { host }" }, 400);
            }
            try {
                return c.json(await arrivals.scan(parsed.data.host));
            } catch (error) {
                const failed = arrivalFailed(error);
                if (failed === undefined) {
                    throw error;
                }
                return c.json({ error: failed.error }, failed.status);
            }
        },
        /** POST /arrivals/apply */
        apply: async (c: Context<AppEnv>): Promise<Response> => {
            const denied = await ownerDenied(services, c);
            if (denied !== undefined) {
                return denied;
            }
            const parsed = ArrivalApplySchema.safeParse(await c.req.json().catch(() => undefined));
            if (!parsed.success) {
                return c.json({ error: "expected { token, items, includeSecrets }" }, 400);
            }
            try {
                return c.json(await arrivals.apply(parsed.data));
            } catch (error) {
                const failed = arrivalFailed(error);
                if (failed === undefined) {
                    throw error;
                }
                return c.json({ error: failed.error }, failed.status);
            }
        },
        /** DELETE /arrivals */
        abandon: async (c: Context<AppEnv>): Promise<Response> => {
            const denied = await ownerDenied(services, c);
            if (denied !== undefined) {
                return denied;
            }
            return c.json({ ok: await arrivals.abandon() });
        },
    };
};
