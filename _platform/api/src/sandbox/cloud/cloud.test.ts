import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudCredentialError, CloudProviderError } from "./common.js";
import { digitaloceanCreate, digitaloceanOptions } from "./digitalocean.js";
import { hetznerCreate, hetznerOptions } from "./hetzner.js";
import { oracleCreate, oracleOptions } from "./oracle.js";
import { cloudInitUserData } from "./user-data.js";

// Route the stubbed fetch by method + URL substring, recording calls for payload assertions — the
// ../cloudflare.test.ts helper, with the JSON error tolerance the providers' plain-text 500s need.
const stubFetch = (routes: { match: (method: string, url: string) => boolean; respond: () => Response }[]) => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    vi.stubGlobal(`fetch`, (url: URL | string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? `GET`;
        calls.push({ method, url: String(url), ...(typeof init?.body === `string` ? { body: JSON.parse(init.body) } : {}) });
        const route = routes.find((candidate) => candidate.match(method, String(url)));
        if (!route) {
            throw new Error(`unexpected fetch: ${method} ${String(url)}`);
        }
        return Promise.resolve(route.respond());
    });
    return calls;
};

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(`cloudInitUserData`, () => {
    it(`is the published one-liner, headless: docker consent, platform override, code and -y`, () => {
        const script = cloudInitUserData({ scriptOrigin: `https://site.test`, platformUrl: `https://api.test`, setupCode: `c0de` });
        expect(script.startsWith(`#!/bin/sh\n`)).toBe(true);
        expect(script).toContain(`curl -fsSL https://site.test/connect | INSTALL_DOCKER=1 PLATFORM_URL=https://api.test sh -s -- c0de -y`);
    });
});

describe(`hetzner`, () => {
    const serverTypes = (page: number) =>
        json({
            server_types:
                page === 1
                    ? [
                          {
                              name: `cx22`,
                              cores: 2,
                              memory: 4,
                              disk: 40,
                              deprecated: null,
                              architecture: `x86`,
                              prices: [
                                  { location: `fsn1`, price_monthly: { net: `3.8500` } },
                                  { location: `ash`, price_monthly: { net: `4.1000` } },
                              ],
                          },
                          {
                              name: `cax11`,
                              cores: 2,
                              memory: 4,
                              disk: 40,
                              deprecated: null,
                              architecture: `arm`,
                              prices: [{ location: `fsn1`, price_monthly: { net: `3.2900` } }],
                          },
                          {
                              name: `cx11`,
                              cores: 1,
                              memory: 2,
                              disk: 20,
                              deprecated: null,
                              architecture: `x86`,
                              prices: [{ location: `fsn1`, price_monthly: { net: `2.9900` } }],
                          },
                      ]
                    : [
                          {
                              name: `cx32`,
                              cores: 4,
                              memory: 8,
                              disk: 80,
                              deprecated: {},
                              architecture: `x86`,
                              prices: [{ location: `fsn1`, price_monthly: { net: `6.8000` } }],
                          },
                      ],
            meta: { pagination: { next_page: page === 1 ? 2 : null } },
        });
    const locations = json({
        locations: [
            { name: `ash`, city: `Ashburn`, country: `US` },
            { name: `fsn1`, city: `Falkenstein`, country: `DE` },
        ],
    });

    it(`walks the pages and curates: x86, current, ≥4 GB, priced from the cheapest location`, async () => {
        stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/server_types`) && url.includes(`page=1`), respond: () => serverTypes(1) },
            { match: (method, url) => method === `GET` && url.includes(`/server_types`) && url.includes(`page=2`), respond: () => serverTypes(2) },
            { match: (method, url) => method === `GET` && url.includes(`/locations`), respond: () => locations },
        ]);
        const options = await hetznerOptions(`tok`);
        // cax11 (arm), cx11 (2 GB) and cx32 (deprecated) are all filtered out.
        expect(options.sizes).toEqual([{ id: `cx22`, label: `CX22`, cpus: 2, memoryGb: 4, diskGb: 40, monthlyPrice: 3.85, currency: `EUR` }]);
        expect(options.defaultLocation).toBe(`fsn1`);
        expect(options.defaultSize).toBe(`cx22`);
        expect(options.locations).toContainEqual({ id: `fsn1`, label: `Falkenstein (DE)` });
    });

    it(`creates the server with Ubuntu, the user-data and the intentic label`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/servers`), respond: () => json({ server: { id: 42 } }) },
        ]);
        const created = await hetznerCreate(`tok`, { name: `intentic-sandbox-abc`, location: `fsn1`, size: `cx22`, userData: `#!/bin/sh\n` });
        expect(created.serverId).toBe(`42`);
        expect(calls[0]?.body).toMatchObject({
            name: `intentic-sandbox-abc`,
            server_type: `cx22`,
            image: `ubuntu-24.04`,
            location: `fsn1`,
            user_data: `#!/bin/sh\n`,
            labels: { "managed-by": `intentic` },
        });
    });

    it(`maps 401 to a credential error and named refusals to provider errors`, async () => {
        stubFetch([{ match: () => true, respond: () => new Response(``, { status: 401 }) }]);
        await expect(hetznerOptions(`bad`)).rejects.toBeInstanceOf(CloudCredentialError);

        vi.unstubAllGlobals();
        stubFetch([{ match: () => true, respond: () => json({ error: { code: `resource_limit_exceeded`, message: `limit` } }, 422) }]);
        await expect(hetznerCreate(`tok`, { name: `n`, location: `fsn1`, size: `cx22`, userData: `` })).rejects.toThrowError(/server limit/);

        vi.unstubAllGlobals();
        stubFetch([{ match: () => true, respond: () => json({ error: { code: `uniqueness_error`, message: `taken` } }, 409) }]);
        await expect(hetznerCreate(`tok`, { name: `n`, location: `fsn1`, size: `cx22`, userData: `` })).rejects.toThrowError(/already exists/);
    });
});

describe(`digitalocean`, () => {
    const sizes = json({
        sizes: [
            { slug: `s-2vcpu-4gb`, memory: 4096, vcpus: 2, disk: 80, price_monthly: 24, regions: [`fra1`, `nyc1`], available: true },
            { slug: `s-1vcpu-2gb`, memory: 2048, vcpus: 1, disk: 50, price_monthly: 12, regions: [`fra1`], available: true },
            { slug: `c-4`, memory: 8192, vcpus: 4, disk: 50, price_monthly: 84, regions: [`fra1`], available: true },
            { slug: `s-4vcpu-8gb`, memory: 8192, vcpus: 4, disk: 160, price_monthly: 48, regions: [`nyc1`], available: false },
        ],
    });
    const regions = json({
        regions: [
            { slug: `fra1`, name: `Frankfurt 1`, available: true },
            { slug: `nyc1`, name: `New York 1`, available: true },
            { slug: `sgp1`, name: `Singapore 1`, available: true },
        ],
    });

    it(`curates available basic ≥4 GB sizes and only regions that stock one`, async () => {
        stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/sizes`), respond: () => sizes },
            { match: (method, url) => method === `GET` && url.includes(`/regions`), respond: () => regions },
        ]);
        const options = await digitaloceanOptions(`tok`);
        expect(options.sizes).toEqual([
            { id: `s-2vcpu-4gb`, label: `S-2VCPU-4GB`, cpus: 2, memoryGb: 4, diskGb: 80, monthlyPrice: 24, currency: `USD` },
        ]);
        // sgp1 stocks none of the offered sizes; the unavailable s-4vcpu-8gb must not keep nyc1 out.
        expect(options.locations.map((location) => location.id)).toEqual([`fra1`, `nyc1`]);
        expect(options.defaultLocation).toBe(`fra1`);
    });

    it(`creates the droplet with Ubuntu, the user-data and the intentic tag; refusals pass through named`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/droplets`), respond: () => json({ droplet: { id: 7 } }, 202) },
        ]);
        const created = await digitaloceanCreate(`tok`, { name: `intentic-sandbox-abc`, location: `fra1`, size: `s-2vcpu-4gb`, userData: `#!` });
        expect(created.serverId).toBe(`7`);
        expect(calls[0]?.body).toMatchObject({
            name: `intentic-sandbox-abc`,
            region: `fra1`,
            size: `s-2vcpu-4gb`,
            image: `ubuntu-24-04-x64`,
            user_data: `#!`,
            tags: [`intentic`],
        });

        vi.unstubAllGlobals();
        stubFetch([
            {
                match: () => true,
                respond: () => json({ id: `unprocessable_entity`, message: `creating this droplet will exceed your droplet limit` }, 422),
            },
        ]);
        await expect(digitaloceanCreate(`tok`, { name: `n`, location: `fra1`, size: `s-2vcpu-4gb`, userData: `` })).rejects.toThrowError(
            /droplet limit/,
        );

        vi.unstubAllGlobals();
        stubFetch([{ match: () => true, respond: () => new Response(``, { status: 401 }) }]);
        await expect(digitaloceanOptions(`bad`)).rejects.toBeInstanceOf(CloudCredentialError);
    });
});

describe(`oracle`, () => {
    const pem = generateKeyPairSync(`rsa`, { modulusLength: 2048 }).privateKey.export({ type: `pkcs8`, format: `pem` }).toString();
    const snippet = [`user=ocid1.user.oc1..alice`, `fingerprint=aa:bb`, `tenancy=ocid1.tenancy.oc1..acme`, `region=eu-frankfurt-1`].join(`\n`);

    it(`lists availability domains as locations with the one pinned free shape`, async () => {
        stubFetch([
            {
                match: (method, url) => method === `GET` && url.includes(`/availabilityDomains/`),
                respond: () => json([{ name: `fVpF:EU-FRANKFURT-1-AD-1` }, { name: `fVpF:EU-FRANKFURT-1-AD-2` }]),
            },
        ]);
        const options = await oracleOptions(snippet, pem);
        expect(options.locations).toHaveLength(2);
        expect(options.sizes).toEqual([
            { id: `VM.Standard.A1.Flex`, label: `A1.Flex (Always Free)`, cpus: 2, memoryGb: 12, diskGb: 50, monthlyPrice: 0, currency: `USD` },
        ]);
        expect(options.defaultLocation).toBe(`fVpF:EU-FRANKFURT-1-AD-1`);
    });

    it(`creates the network once and launches the pinned free shape with base64 user-data`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/images?`), respond: () => json([{ id: `ocid1.image.oc1..ubuntu` }]) },
            { match: (method, url) => method === `GET` && url.includes(`/vcns?`), respond: () => json([]) },
            {
                match: (method, url) => method === `POST` && url.endsWith(`/vcns`),
                respond: () => json({ id: `vcn1`, lifecycleState: `AVAILABLE`, defaultRouteTableId: `rt1` }),
            },
            { match: (method, url) => method === `GET` && url.includes(`/internetGateways?`), respond: () => json([]) },
            { match: (method, url) => method === `POST` && url.endsWith(`/internetGateways`), respond: () => json({ id: `igw1` }) },
            { match: (method, url) => method === `GET` && url.includes(`/routeTables/rt1`), respond: () => json({ routeRules: [] }) },
            { match: (method, url) => method === `PUT` && url.includes(`/routeTables/rt1`), respond: () => json({}) },
            { match: (method, url) => method === `GET` && url.includes(`/subnets?`), respond: () => json([]) },
            { match: (method, url) => method === `POST` && url.endsWith(`/subnets`), respond: () => json({ id: `sub1` }) },
            { match: (method, url) => method === `POST` && url.endsWith(`/instances/`), respond: () => json({ id: `ocid1.instance.oc1..vm` }) },
        ]);
        const created = await oracleCreate(snippet, pem, {
            name: `intentic-sandbox-abc`,
            location: `fVpF:EU-FRANKFURT-1-AD-1`,
            size: `VM.Standard.A1.Flex`,
            userData: `#!/bin/sh\n`,
        });
        expect(created.serverId).toBe(`ocid1.instance.oc1..vm`);
        const route = calls.find((entry) => entry.method === `PUT`);
        expect(route?.body).toEqual({ routeRules: [{ destination: `0.0.0.0/0`, destinationType: `CIDR_BLOCK`, networkEntityId: `igw1` }] });
        const launch = calls.find((entry) => entry.method === `POST` && entry.url.endsWith(`/instances/`));
        expect(launch?.body).toMatchObject({
            availabilityDomain: `fVpF:EU-FRANKFURT-1-AD-1`,
            shape: `VM.Standard.A1.Flex`,
            shapeConfig: { ocpus: 2, memoryInGBs: 12 },
            createVnicDetails: { subnetId: `sub1`, assignPublicIp: true },
            sourceDetails: { sourceType: `image`, imageId: `ocid1.image.oc1..ubuntu`, bootVolumeSizeInGBs: 50 },
            metadata: { user_data: Buffer.from(`#!/bin/sh\n`).toString(`base64`) },
        });
    });

    it(`reuses an existing intentic network untouched — no creates, no route rewrite`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `GET` && url.includes(`/images?`), respond: () => json([{ id: `img` }]) },
            {
                match: (method, url) => method === `GET` && url.includes(`/vcns?`),
                respond: () => json([{ id: `vcn1`, lifecycleState: `AVAILABLE`, defaultRouteTableId: `rt1` }]),
            },
            { match: (method, url) => method === `GET` && url.includes(`/internetGateways?`), respond: () => json([{ id: `igw1` }]) },
            {
                match: (method, url) => method === `GET` && url.includes(`/routeTables/rt1`),
                respond: () => json({ routeRules: [{ destination: `0.0.0.0/0`, networkEntityId: `igw1` }] }),
            },
            { match: (method, url) => method === `GET` && url.includes(`/subnets?`), respond: () => json([{ id: `sub1` }]) },
            { match: (method, url) => method === `POST` && url.endsWith(`/instances/`), respond: () => json({ id: `vm` }) },
        ]);
        await oracleCreate(snippet, pem, { name: `n`, location: `ad1`, size: `VM.Standard.A1.Flex`, userData: `` });
        expect(calls.filter((entry) => entry.method !== `GET`).map((entry) => entry.url)).toEqual([expect.stringContaining(`/instances/`)]);
    });

    // The reused-network routes every capacity test shares — only the instance POST (and the domain list the
    // walk fetches after a first miss) differ per case.
    const capacityStubs = () => [
        { match: (method: string, url: string) => method === `GET` && url.includes(`/images?`), respond: () => json([{ id: `img` }]) },
        {
            match: (method: string, url: string) => method === `GET` && url.includes(`/vcns?`),
            respond: () => json([{ id: `vcn1`, lifecycleState: `AVAILABLE`, defaultRouteTableId: `rt1` }]),
        },
        { match: (method: string, url: string) => method === `GET` && url.includes(`/internetGateways?`), respond: () => json([{ id: `igw1` }]) },
        {
            match: (method: string, url: string) => method === `GET` && url.includes(`/routeTables/rt1`),
            respond: () => json({ routeRules: [{ destination: `0.0.0.0/0` }] }),
        },
        { match: (method: string, url: string) => method === `GET` && url.includes(`/subnets?`), respond: () => json([{ id: `sub1` }]) },
        {
            match: (method: string, url: string) => method === `GET` && url.includes(`/availabilityDomains/`),
            respond: () => json([{ name: `ad1` }, { name: `ad2` }, { name: `ad3` }]),
        },
    ];

    it(`walks the other availability domains on a capacity miss and launches where there is room`, async () => {
        const calls = stubFetch([
            ...capacityStubs(),
            {
                match: (method, url) => method === `POST` && url.endsWith(`/instances/`),
                // ad1 (the pick) refuses, ad2 has room — reading the body decides, so the stub is stateless.
                respond: () => json({ code: `InternalError`, message: `Out of host capacity.` }, 500),
            },
        ]);
        // Re-route the instance POST per body: refuse ad1, accept everything after.
        const instanceRoute = calls; // recorded calls carry the body the walk sent
        vi.stubGlobal(`fetch`, ((original) =>
            (url: URL | string, init?: RequestInit): Promise<Response> => {
                const body = typeof init?.body === `string` ? (JSON.parse(init.body) as { availabilityDomain?: string }) : {};
                if (String(url).endsWith(`/instances/`) && body.availabilityDomain !== `ad1`) {
                    instanceRoute.push({ method: `POST`, url: String(url), body });
                    return Promise.resolve(json({ id: `vm-ad2` }));
                }
                return original(url, init);
            })(globalThis.fetch as (url: URL | string, init?: RequestInit) => Promise<Response>));
        const created = await oracleCreate(snippet, pem, { name: `n`, location: `ad1`, size: `VM.Standard.A1.Flex`, userData: `` });
        expect(created.serverId).toBe(`vm-ad2`);
        const launched = instanceRoute.filter((entry) => entry.url.endsWith(`/instances/`));
        const last = launched.at(-1)?.body as { availabilityDomain?: string } | undefined;
        expect(last?.availabilityDomain).toBe(`ad2`);
    });

    it(`names the A1 capacity refusal honestly — after every domain — and never launches a non-free shape`, async () => {
        stubFetch([
            ...capacityStubs(),
            {
                match: (method, url) => method === `POST` && url.endsWith(`/instances/`),
                respond: () => json({ code: `InternalError`, message: `Out of host capacity.` }, 500),
            },
        ]);
        await expect(oracleCreate(snippet, pem, { name: `n`, location: `ad1`, size: `VM.Standard.A1.Flex`, userData: `` })).rejects.toThrowError(
            /free-tier ARM capacity in any availability domain/,
        );

        await expect(oracleCreate(snippet, pem, { name: `n`, location: `ad1`, size: `VM.Standard.E4.Flex`, userData: `` })).rejects.toBeInstanceOf(
            CloudProviderError,
        );
    });
});
