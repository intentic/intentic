import { z } from "zod";
import { ORACLE_CAPACITY_PHRASE, type CloudOptions } from "@intentic-app/api-contract";
import { CloudCredentialError, CloudProviderError, type CloudCreate } from "./common.js";
import { parseOciConfig, signedHeaders, type OciCredential } from "./oci-sign.js";

/* Oracle Cloud, the Always-Free lane: an ARM VM inside the user's own free-tier allowance — the one provider
 * where the machine can cost nothing. Everything happens in the tenancy ROOT compartment (free-tier accounts
 * don't manage compartments) with the A1.Flex shape pinned to the 2 OCPU / 12 GB the free tier allows since
 * June 2026 — a bigger ask would silently bill a Pay-As-You-Go account, and this lane's promise is "free".
 *
 * Unlike Hetzner/DO, an instance cannot launch into nothing: it needs a VCN + public subnet + internet
 * gateway + default route. `create` finds-or-creates that network under the fixed name "intentic" — a rerun
 * (or a second sandbox) reuses it rather than stacking VCNs, and nothing existing is ever modified except
 * appending the default route when the table lacks one. */

const FREE_SHAPE = { id: `VM.Standard.A1.Flex`, ocpus: 2, memoryGb: 12, diskGb: 50 } as const;
const NETWORK_NAME = `intentic`;

// Capacity is weather, not a verdict — see the throw site in `call` and the domain walk in `oracleCreate`.
class OracleCapacityError extends CloudProviderError {}

const errorSchema = z.object({ code: z.string(), message: z.string() });
const availabilityDomainsSchema = z.array(z.object({ name: z.string() }));
const vcnSchema = z.object({
    id: z.string(),
    lifecycleState: z.string(),
    defaultRouteTableId: z.string(),
});
const vcnListSchema = z.array(vcnSchema);
const idSchema = z.object({ id: z.string() });
const listOfIdsSchema = z.array(idSchema);
const routeTableSchema = z.object({
    routeRules: z.array(z.looseObject({ destination: z.string().optional() })),
});
const imagesSchema = z.array(z.object({ id: z.string() }));

const endpoint = (credential: OciCredential, service: `identity` | `iaas`): string => `https://${service}.${credential.region}.oraclecloud.com`;

const call = async (credential: OciCredential, method: string, url: string, body?: unknown): Promise<unknown> => {
    const parsed = new URL(url);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const response = await fetch(parsed, { method, headers: signedHeaders(credential, method, parsed, payload), body: payload });
    if (response.ok) {
        return response.json();
    }
    const failure = errorSchema.safeParse(await response.json().catch(() => undefined));
    if (response.status === 401) {
        throw new CloudCredentialError(
            `Oracle rejected the API key (${failure.success ? failure.data.message : `not authenticated`}) — re-paste the config snippet and the matching private key from Profile → API keys.`,
        );
    }
    if (failure.success) {
        // The A1 free tier's famous refusal: no ARM capacity in that availability domain right now. Its own
        // error class because `create` reacts to it — trying the OTHER domains before giving up — where every
        // other refusal propagates as final. The phrase is the contract's (ORACLE_CAPACITY_PHRASE): the
        // wizard keys its keep-trying offer on it.
        if (/out of host capacity/i.test(failure.data.message)) {
            throw new OracleCapacityError(
                `Oracle has ${ORACLE_CAPACITY_PHRASE} in that availability domain right now (their notorious A1 shortage). Capacity is released continuously — retry in a bit.`,
            );
        }
        if (failure.data.code === `LimitExceeded`) {
            throw new CloudProviderError(
                `Oracle refused: your tenancy's free-tier limit is used up (${failure.data.message}). Delete an unused A1 instance in the Oracle console, then retry.`,
            );
        }
        if (failure.data.code === `NotAuthorizedOrNotFound`) {
            throw new CloudProviderError(
                `Oracle refused: not authorized (${failure.data.message}). The API key's user needs to be in the Administrators group of this tenancy.`,
            );
        }
        throw new CloudProviderError(`Oracle refused: ${failure.data.message}`);
    }
    throw new Error(`Oracle API ${method} ${parsed.pathname} failed with HTTP ${response.status}`);
};

// Options doubles as the credential check everywhere; here the availability-domain list is also a real pick —
// A1 capacity differs per domain, so surfacing all of them gives the user somewhere to go on a capacity miss.
export const oracleOptions = async (config: string, privateKeyPem: string): Promise<CloudOptions> => {
    const credential = parseOciConfig(config, privateKeyPem);
    const domains = availabilityDomainsSchema.parse(
        await call(
            credential,
            `GET`,
            `${endpoint(credential, `identity`)}/20160918/availabilityDomains/?compartmentId=${encodeURIComponent(credential.tenancy)}`,
        ),
    );
    const first = domains[0];
    if (first === undefined) {
        throw new CloudProviderError(
            `Oracle listed no availability domains for this tenancy — check that the config snippet's region is where your account lives.`,
        );
    }
    return {
        locations: domains.map((domain) => ({ id: domain.name, label: domain.name })),
        sizes: [
            {
                id: FREE_SHAPE.id,
                label: `A1.Flex (Always Free)`,
                cpus: FREE_SHAPE.ocpus,
                memoryGb: FREE_SHAPE.memoryGb,
                diskGb: FREE_SHAPE.diskGb,
                monthlyPrice: 0,
                currency: `USD`,
            },
        ],
        defaultLocation: first.name,
        defaultSize: FREE_SHAPE.id,
    };
};

// A VCN in AVAILABLE state with the default route to an internet gateway, found or created. Creation is
// eventually consistent (a subnet on a still-PROVISIONING VCN 409s), so a fresh VCN is polled briefly.
const ensureNetwork = async (credential: OciCredential): Promise<{ subnetId: string }> => {
    const core = `${endpoint(credential, `iaas`)}/20160918`;
    const compartment = `compartmentId=${encodeURIComponent(credential.tenancy)}`;
    const existing = vcnListSchema.parse(await call(credential, `GET`, `${core}/vcns?${compartment}&displayName=${NETWORK_NAME}`));
    let vcn = existing[0];
    if (vcn === undefined) {
        vcn = vcnSchema.parse(
            await call(credential, `POST`, `${core}/vcns`, {
                cidrBlock: `10.0.0.0/16`,
                compartmentId: credential.tenancy,
                displayName: NETWORK_NAME,
            }),
        );
    }
    for (let attempt = 0; vcn.lifecycleState !== `AVAILABLE`; attempt += 1) {
        if (attempt >= 15) {
            throw new CloudProviderError(
                `Oracle's network stayed in ${vcn.lifecycleState} — retry in a minute (the half-made "${NETWORK_NAME}" network will be reused).`,
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
        vcn = vcnSchema.parse(await call(credential, `GET`, `${core}/vcns/${vcn.id}`));
    }
    const gateways = listOfIdsSchema.parse(await call(credential, `GET`, `${core}/internetGateways?${compartment}&vcnId=${vcn.id}`));
    const gateway =
        gateways[0] ??
        idSchema.parse(
            await call(credential, `POST`, `${core}/internetGateways`, {
                compartmentId: credential.tenancy,
                vcnId: vcn.id,
                isEnabled: true,
                displayName: NETWORK_NAME,
            }),
        );
    // Append the default route only when the table lacks one — an existing 0.0.0.0/0 rule (this network's own
    // from a previous run, or a hand-managed table) is left exactly as found.
    const table = routeTableSchema.parse(await call(credential, `GET`, `${core}/routeTables/${vcn.defaultRouteTableId}`));
    if (!table.routeRules.some((rule) => rule.destination === `0.0.0.0/0`)) {
        await call(credential, `PUT`, `${core}/routeTables/${vcn.defaultRouteTableId}`, {
            routeRules: [...table.routeRules, { destination: `0.0.0.0/0`, destinationType: `CIDR_BLOCK`, networkEntityId: gateway.id }],
        });
    }
    const subnets = listOfIdsSchema.parse(
        await call(credential, `GET`, `${core}/subnets?${compartment}&vcnId=${vcn.id}&displayName=${NETWORK_NAME}`),
    );
    const subnet =
        subnets[0] ??
        idSchema.parse(
            await call(credential, `POST`, `${core}/subnets`, {
                cidrBlock: `10.0.0.0/24`,
                compartmentId: credential.tenancy,
                vcnId: vcn.id,
                displayName: NETWORK_NAME,
            }),
        );
    return { subnetId: subnet.id };
};

// One free-tier instance: newest Ubuntu 24.04 image compatible with the A1 shape (the shape filter is what
// makes ListImages answer aarch64 builds), the ensured network, and the setup one-liner as user_data. `size`
// from the wizard is asserted against the pinned free shape rather than trusted — this adapter never launches
// anything that could bill.
//
// CAPACITY IS WALKED, NOT REPORTED: A1 capacity differs per availability domain and shifts by the minute, so
// a capacity refusal in the picked domain tries every other domain of the region before giving up — the loop
// a person runs by hand in the console (pick the next domain, press create again), automated. Only the
// capacity refusal continues the walk; any other refusal is a verdict and propagates from the domain it
// happened in. The exhausted-everything error carries the contract's capacity phrase, so the wizard can offer
// to keep retrying — by then it is a matter of WHEN, not where.
export const oracleCreate = async (config: string, privateKeyPem: string, create: CloudCreate): Promise<{ serverId: string }> => {
    const credential = parseOciConfig(config, privateKeyPem);
    if (create.size !== FREE_SHAPE.id) {
        throw new CloudProviderError(`Oracle machines are pinned to the free-tier shape ${FREE_SHAPE.id}.`);
    }
    const core = `${endpoint(credential, `iaas`)}/20160918`;
    const images = imagesSchema.parse(
        await call(
            credential,
            `GET`,
            `${core}/images?compartmentId=${encodeURIComponent(credential.tenancy)}&operatingSystem=${encodeURIComponent(`Canonical Ubuntu`)}&operatingSystemVersion=24.04&shape=${FREE_SHAPE.id}&sortBy=TIMECREATED&sortOrder=DESC&limit=1`,
        ),
    );
    const image = images[0];
    if (image === undefined) {
        throw new CloudProviderError(`Oracle offers no Ubuntu 24.04 image for ${FREE_SHAPE.id} in ${credential.region}.`);
    }
    const { subnetId } = await ensureNetwork(credential);
    const launch = async (availabilityDomain: string): Promise<{ serverId: string }> => {
        const instance = idSchema.parse(
            await call(credential, `POST`, `${core}/instances/`, {
                availabilityDomain,
                compartmentId: credential.tenancy,
                displayName: create.name,
                shape: FREE_SHAPE.id,
                shapeConfig: { ocpus: FREE_SHAPE.ocpus, memoryInGBs: FREE_SHAPE.memoryGb },
                createVnicDetails: { subnetId, assignPublicIp: true },
                sourceDetails: { sourceType: `image`, imageId: image.id, bootVolumeSizeInGBs: FREE_SHAPE.diskGb },
                metadata: { user_data: Buffer.from(create.userData).toString(`base64`) },
            }),
        );
        return { serverId: instance.id };
    };
    // The picked domain first, then the region's others — fetched only on the first capacity miss, so the
    // happy path pays no extra round-trip.
    try {
        return await launch(create.location);
    } catch (error) {
        if (!(error instanceof OracleCapacityError)) {
            throw error;
        }
    }
    const domains = availabilityDomainsSchema.parse(
        await call(credential, `GET`, `${endpoint(credential, `identity`)}/20160918/availabilityDomains/?compartmentId=${encodeURIComponent(credential.tenancy)}`),
    );
    for (const domain of domains.map((entry) => entry.name).filter((name) => name !== create.location)) {
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- the walk IS sequential: each domain is tried only because the previous had no capacity
            return await launch(domain);
        } catch (error) {
            if (!(error instanceof OracleCapacityError)) {
                throw error;
            }
        }
    }
    throw new CloudProviderError(
        `Oracle has ${ORACLE_CAPACITY_PHRASE} in any availability domain of ${credential.region} right now (their notorious A1 shortage). Capacity is released continuously — keep this page open and it will keep trying, or come back later.`,
    );
};
