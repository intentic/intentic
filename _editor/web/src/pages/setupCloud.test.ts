import { describe, expect, it } from "vitest";
import { CLOUD_PROVIDERS, cloudCredentials, cloudProviderMeta, priceLabel, sizeLabel } from "./setupCloud";

describe(`cloudCredentials`, () => {
    it(`gates the token providers on a non-empty trimmed token`, () => {
        expect(cloudCredentials(`hetzner`, { token: `  `, ociConfig: ``, ociKey: `` })).toBeUndefined();
        expect(cloudCredentials(`hetzner`, { token: ` t0k `, ociConfig: ``, ociKey: `` })).toEqual({ provider: `hetzner`, token: `t0k` });
        expect(cloudCredentials(`digitalocean`, { token: `dop_v1_x`, ociConfig: ``, ociKey: `` })).toEqual({
            provider: `digitalocean`,
            token: `dop_v1_x`,
        });
    });

    it(`gates oracle on BOTH pastes — a config without its key is not a credential`, () => {
        expect(cloudCredentials(`oracle`, { token: ``, ociConfig: `user=x`, ociKey: `` })).toBeUndefined();
        expect(cloudCredentials(`oracle`, { token: ``, ociConfig: ``, ociKey: `pem` })).toBeUndefined();
        expect(cloudCredentials(`oracle`, { token: ``, ociConfig: `user=x`, ociKey: `pem` })).toEqual({
            provider: `oracle`,
            config: `user=x`,
            privateKey: `pem`,
        });
    });
});

describe(`provider metadata`, () => {
    it(`covers every contract provider exactly once, resolvable by id`, () => {
        expect(CLOUD_PROVIDERS.map((provider) => provider.id).sort()).toEqual([`digitalocean`, `hetzner`, `oracle`]);
        for (const provider of CLOUD_PROVIDERS) {
            expect(cloudProviderMeta(provider.id)).toBe(provider);
        }
    });
});

describe(`labels`, () => {
    const size = { id: `cx22`, label: `CX22`, cpus: 2, memoryGb: 4, diskGb: 40, monthlyPrice: 3.85, currency: `EUR` };

    it(`prices in the provider's own currency, free shapes as the word`, () => {
        expect(priceLabel(size)).toBe(`€3.85/mo`);
        expect(priceLabel({ ...size, monthlyPrice: 24, currency: `USD` })).toBe(`$24/mo`);
        expect(priceLabel({ ...size, monthlyPrice: 0, currency: `USD` })).toBe(`Free`);
    });

    it(`describes a size as one picker row`, () => {
        expect(sizeLabel(size)).toBe(`CX22 — 2 vCPU · 4 GB RAM · 40 GB disk · €3.85/mo`);
    });
});
