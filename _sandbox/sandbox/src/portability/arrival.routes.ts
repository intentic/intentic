import { ArrivalApplySchema, ArrivalScanSchema } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { ArrivalFormatError, ArrivalStaleError } from "../arrival-error.js";
import { ownerDenied } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { MAX_UPLOAD_BYTES, UploadTooLargeError } from "../workspace/files/workspace-files-upload.js";
import { createArrivals } from "./arrival.js";

/* ARRIVALS: everything coming INTO this sandbox, through one preview-first pipeline
 * (portability/arrival.ts). A `sandbox.toml`, an environment bundle, a packed Hermes or OpenClaw home
 * directory — three surfaces once, with three sets of routes and three sets of schemas doing the same four
 * things to different bytes.
 *
 * Raw Hono rather than oRPC because a plan's input is an upload STREAM of arbitrary size, and owner-only
 * throughout: the artifact may be somebody's credential store, and the apply writes repositories, settings,
 * skills, automations, capabilities and, for a bundle, the workspace itself.
 *
 * FOUR CALLS, AND THE FORMAT IS NOT ONE OF THEM. `plan` sniffs the upload and answers with a checklist,
 * `scan` reads a connected device instead of a file, `apply` names the ticked ids, DELETE throws the
 * held artifact away. Whoever is uploading knows what they have; the daemon can tell from two bytes and
 * the first tar header, so asking them to pick a route for it was work with nothing on the other side. */

// The two ways a caller can be wrong, told apart, because the answers differ: a file that is not what it
// claims is a 400 with the reader's own sentence, while a token that no longer matches means the FILE was
// fine and the preview went stale, which is a 409 and a re-read.
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
        /* GET /arrivals/hosts. The owner's own devices as arrival sources, probed live, because the whole value
         * is that the offer appears BEFORE they read a packing instruction. Never fails the card: a machine that
         * is asleep or holds nothing is a row saying so, which is why every probe is caught into its own
         * `detail`. */
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
