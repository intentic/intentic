import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs } from "../core/inputs.js";
import type { CloudflareApi } from "./cloudflare-api.js";
import { cloudflareApi } from "./cloudflare-api.js";

const cloudflareSchema = z.object({ apiToken: z.string(), zone: z.string() });
const parse = (inputs: ResolvedInputs): z.infer<typeof cloudflareSchema> => parseInputs(cloudflareSchema, inputs, "cloudflare");

// The Cloudflare zone is OWNED — the provider RESOLVES the zone name to its zone id (and the account that
// owns it) over the API; it never creates a zone. read returns the mapping if the zone exists, undefined
// (logged) if not, so a plan surfaces a misconfigured zone without aborting. diff is always noop (an owned,
// immutable name->id mapping has no managed drift). apply is reached only when read found nothing; it
// re-resolves and raises the hard error on a persistent not-found — an owned zone is not created here.
export const createCloudflareProvider = (api: CloudflareApi = cloudflareApi): Provider => ({
    read: async (inputs, ctx) => {
        const { apiToken, zone } = parse(inputs);
        const found = await api.getZone({ apiToken, zone });
        if (found === undefined) {
            ctx.log(`cloudflare "${ctx.id}": zone "${zone}" not found, treating as not-yet-resolved`);
            return undefined;
        }
        return { outputs: { zoneId: found.id, accountId: found.accountId } };
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs) => {
        const { apiToken, zone } = parse(inputs);
        const found = await api.getZone({ apiToken, zone });
        if (found === undefined) {
            throw new Error(`cloudflare zone "${zone}" does not exist (owned zones are not created)`);
        }
        return { zoneId: found.id, accountId: found.accountId };
    },
    // The zone is OWNED — intentic never deletes it. Logged no-op so prune treats it as handled.
    delete: async (_inputs, ctx) => {
        ctx.log(`cloudflare "${ctx.id}" removed from desired state — the owned zone is never deleted`);
    },
});
