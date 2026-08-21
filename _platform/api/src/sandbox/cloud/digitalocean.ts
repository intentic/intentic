import type { CloudOptions } from "@intentic-app/api-contract";
import { z } from "zod";
import { CloudCredentialError, CloudProviderError, type CloudCreate } from "./common.js";

// DigitalOcean: one personal access token (write scope) is the credential, spent request-scoped like every
// adapter here (../cloudflare.ts contract). Plain fetch against the v2 API.

const BASE = `https://api.digitalocean.com/v2`;

// DO's error envelope: { id: "unauthorized" | "unprocessable_entity" | …, message }.
const errorSchema = z.object({ id: z.string(), message: z.string() });

const sizesSchema = z.object({
    sizes: z.array(
        z.object({
            slug: z.string(),
            memory: z.number(), // MB
            vcpus: z.number(),
            disk: z.number(),
            price_monthly: z.number(),
            regions: z.array(z.string()),
            available: z.boolean(),
        }),
    ),
});
const regionsSchema = z.object({
    regions: z.array(z.object({ slug: z.string(), name: z.string(), available: z.boolean() })),
});
const createdSchema = z.object({ droplet: z.object({ id: z.number() }) });

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
            `DigitalOcean rejected the token: create a personal access token with write scope (API → Tokens) and paste it again.`,
        );
    }
    const parsed = errorSchema.safeParse(await response.json().catch(() => undefined));
    if (parsed.success) {
        // DO writes its refusals for humans already ("creating this droplet will exceed your droplet
        // limit…"), so the message passes through with the provider named.
        throw new CloudProviderError(`DigitalOcean refused: ${parsed.data.message}`);
    }
    throw new Error(`DigitalOcean API ${method} ${path} failed with HTTP ${response.status}`);
};

// The curated catalog: available basic (s-…) shared-CPU droplets with sandbox-worthy RAM, priced live from
// DO's own numbers. Regions are cross-filtered to ones that actually stock at least one offered size, so the
// wizard can never assemble an impossible pick.
export const digitaloceanOptions = async (token: string): Promise<CloudOptions> => {
    const [sizesRaw, regionsRaw] = await Promise.all([call(token, `GET`, `/sizes?per_page=200`), call(token, `GET`, `/regions?per_page=200`)]);
    const sizes = sizesSchema
        .parse(sizesRaw)
        .sizes.filter((entry) => entry.available && entry.slug.startsWith(`s-`) && entry.memory >= 4096)
        .toSorted((a, b) => a.price_monthly - b.price_monthly)
        .slice(0, 5);
    const cheapest = sizes[0];
    if (cheapest === undefined) {
        throw new CloudProviderError(`DigitalOcean listed no usable droplet sizes for this token.`);
    }
    const stocked = new Set(sizes.flatMap((entry) => entry.regions));
    const regions = regionsSchema.parse(regionsRaw).regions.filter((entry) => entry.available && stocked.has(entry.slug));
    return {
        locations: regions.map((entry) => ({ id: entry.slug, label: entry.name })),
        sizes: sizes.map((entry) => ({
            id: entry.slug,
            label: entry.slug.toUpperCase(),
            cpus: entry.vcpus,
            memoryGb: entry.memory / 1024,
            diskGb: entry.disk,
            monthlyPrice: entry.price_monthly,
            currency: `USD`,
        })),
        defaultLocation: regions.some((entry) => entry.slug === `fra1`) ? `fra1` : (regions[0]?.slug ?? ``),
        defaultSize: cheapest.slug,
    };
};

// One droplet, Ubuntu 24.04, first boot = the setup one-liner. No SSH key on purpose (nothing dials in; DO
// mails the root password for manual rescue); tagged so the user can tell it apart in their console.
export const digitaloceanCreate = async (token: string, create: CloudCreate): Promise<{ serverId: string }> => {
    const created = createdSchema.parse(
        await call(token, `POST`, `/droplets`, {
            name: create.name,
            region: create.location,
            size: create.size,
            image: `ubuntu-24-04-x64`,
            user_data: create.userData,
            tags: [`intentic`],
        }),
    );
    return { serverId: String(created.droplet.id) };
};
