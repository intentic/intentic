import type { CloudOptions } from "@intentic-app/api-contract";
import { z } from "zod";
import { CloudCredentialError, CloudProviderError, type CloudCreate } from "./common.js";

// Hetzner Cloud, the cheap-x86 lane: one project API token (Read & Write) is the whole credential. Plain
// fetch against the documented v1 API; the token is used for the calls of one request and dropped, the
// ../cloudflare.ts contract.

const BASE = `https://api.hetzner.cloud/v1`;

// Hetzner's error envelope rides a non-2xx status: { error: { code, message } }.
const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

const serverTypesSchema = z.object({
    server_types: z.array(
        z.object({
            name: z.string(),
            cores: z.number(),
            memory: z.number(),
            disk: z.number(),
            // Hetzner ships this as an object on deprecated types and null otherwise.
            deprecated: z.unknown().nullable(),
            architecture: z.string(),
            prices: z.array(z.object({ location: z.string(), price_monthly: z.object({ net: z.string() }) })),
        }),
    ),
    meta: z.object({ pagination: z.object({ next_page: z.number().nullable() }) }),
});
const locationsSchema = z.object({
    locations: z.array(z.object({ name: z.string(), city: z.string(), country: z.string() })),
});
const createdSchema = z.object({ server: z.object({ id: z.number() }) });

const call = async (token: string, method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": `application/json` }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.ok) {
        return response.json();
    }
    if (response.status === 401 || response.status === 403) {
        throw new CloudCredentialError(
            `Hetzner rejected the API token — create a Read & Write token under the project the machine should live in (Security → API tokens) and paste it again.`,
        );
    }
    const parsed = errorSchema.safeParse(await response.json().catch(() => undefined));
    if (parsed.success) {
        const { code, message } = parsed.data.error;
        // The refusals a user can act on, in their words. uniqueness_error means a previous attempt already
        // created the machine, pointing at the console beats a retry loop that can never succeed.
        if (code === `uniqueness_error`) {
            throw new CloudProviderError(
                `A server with this sandbox's name already exists in your Hetzner project — it is probably a previous attempt; delete it in the Hetzner console, then retry.`,
            );
        }
        if (code === `resource_limit_exceeded`) {
            throw new CloudProviderError(
                `Hetzner refused: your project's server limit is reached. Raise the limit in the Hetzner console (or delete an unused server), then retry.`,
            );
        }
        if (code === `resource_unavailable`) {
            throw new CloudProviderError(
                `Hetzner has no capacity for that server type in that location right now — pick another location or size and retry.`,
            );
        }
        throw new CloudProviderError(`Hetzner refused: ${message}`);
    }
    throw new Error(`Hetzner API ${method} ${path} failed with HTTP ${response.status}`);
};

// Every server type, across Hetzner's pagination (≈2 pages at 50/page).
const listServerTypes = async (token: string): Promise<z.infer<typeof serverTypesSchema>[`server_types`]> => {
    const types: z.infer<typeof serverTypesSchema>[`server_types`] = [];
    let page: number | null = 1;
    while (page !== null) {
        const parsed = serverTypesSchema.parse(await call(token, `GET`, `/server_types?per_page=50&page=${page}`));
        types.push(...parsed.server_types);
        page = parsed.meta.pagination.next_page;
    }
    return types;
};

// The curated catalog: current-generation shared-x86 types with the RAM a sandbox actually needs (the image
// alone is ~2 GB and agent turns run Node + builds), priced from Hetzner's own numbers, never hard-coded.
// x86-only for now: an ARM pick would need the arm64 image manifest, which is Oracle's lane's rollout.
// monthlyPrice is the cheapest location's net (VAT-free) price; the wizard's copy says "from … excl. VAT".
export const hetznerOptions = async (token: string): Promise<CloudOptions> => {
    const [types, locationsRaw] = await Promise.all([listServerTypes(token), call(token, `GET`, `/locations?per_page=50`)]);
    const locations = locationsSchema.parse(locationsRaw).locations;
    const sizes = types
        .filter((entry) => entry.architecture === `x86` && entry.deprecated === null && entry.memory >= 4)
        .map((entry) => ({
            id: entry.name,
            label: entry.name.toUpperCase(),
            cpus: entry.cores,
            memoryGb: entry.memory,
            diskGb: entry.disk,
            monthlyPrice: Math.min(...entry.prices.map((price) => Number.parseFloat(price.price_monthly.net))),
            currency: `EUR`,
        }))
        .toSorted((a, b) => a.monthlyPrice - b.monthlyPrice)
        .slice(0, 5);
    const cheapest = sizes[0];
    if (cheapest === undefined) {
        throw new CloudProviderError(`Hetzner listed no usable server types for this token's project.`);
    }
    return {
        locations: locations.map((entry) => ({ id: entry.name, label: `${entry.city} (${entry.country})` })),
        sizes,
        defaultLocation: locations.some((entry) => entry.name === `fsn1`) ? `fsn1` : (locations[0]?.name ?? ``),
        defaultSize: cheapest.id,
    };
};

// One VM, Ubuntu 24.04, first boot = the setup one-liner. No SSH key on purpose: nothing ever dials in, the
// machine is driven entirely by its user-data, and Hetzner mails the root password for manual rescue.
export const hetznerCreate = async (token: string, create: CloudCreate): Promise<{ serverId: string }> => {
    const created = createdSchema.parse(
        await call(token, `POST`, `/servers`, {
            name: create.name,
            server_type: create.size,
            image: `ubuntu-24.04`,
            location: create.location,
            user_data: create.userData,
            labels: { "managed-by": `intentic` },
        }),
    );
    return { serverId: String(created.server.id) };
};
