import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ADMIN_TOKEN, type FakeZrok, NAMESPACE_TOKEN, startFakeZrok } from "@intentic/fake-zrok";
import { deleteAccount, type HubConfig, mintAccount, publicNamespaceToken } from "./hub.ts";
import { accountEmail, apiName, apiOrigin, devPlatformId, webName, webOrigin } from "./naming.ts";

/* The three calls the tool makes, run against the same stand-in the platform's own provisioning is tested
 * with — plus the recovery the duplicate-500 exists for, which is the path a re-run after a lost token file
 * actually takes. */

let zrok: FakeZrok | undefined;

const start = async (): Promise<{ hub: FakeZrok; config: HubConfig }> => {
    zrok = await startFakeZrok();
    return { hub: zrok, config: { endpoint: zrok.endpoint, adminToken: DEFAULT_ADMIN_TOKEN } };
};

afterEach(async () => {
    await zrok?.close();
    zrok = undefined;
});

describe(`the grant`, () => {
    it(`mints an account and hands back its token`, async () => {
        const { hub, config } = await start();

        const { accountToken } = await mintAccount(config, { email: `devplat-abc@zone.test`, password: `x` });

        expect(accountToken).toMatch(/.+/);
        expect(hub.accounts.get(`devplat-abc@zone.test`)).toBe(accountToken);
    });

    it(`recovers a duplicate through a delete — the lost-token-file re-run`, async () => {
        const { hub, config } = await start();
        const first = await mintAccount(config, { email: `devplat-abc@zone.test`, password: `x` });

        const second = await mintAccount(config, { email: `devplat-abc@zone.test`, password: `y` });

        expect(second.accountToken).toMatch(/.+/);
        expect(second.accountToken).not.toBe(first.accountToken);
        expect(hub.accounts.size).toBe(1);
    });

    it(`treats deleting an account already gone as done — --reset cannot fail on a half-torn-down state`, async () => {
        const { config } = await start();

        await expect(deleteAccount(config, `devplat-abc@zone.test`)).resolves.toBeUndefined();
    });

    it(`resolves the public namespace the names are claimed under`, async () => {
        const { config } = await start();

        await expect(publicNamespaceToken(config)).resolves.toBe(NAMESPACE_TOKEN);
    });

    it(`turns a rejected admin token into a sentence naming the two settings`, async () => {
        const { config } = await start();

        await expect(publicNamespaceToken({ ...config, adminToken: `wrong` })).rejects.toThrow(/ZROK_ADMIN_TOKEN \/ ZROK_API_ENDPOINT/);
    });
});

describe(`the names`, () => {
    it(`derives one stable id and the pair of labels under the wildcard`, () => {
        const id = devPlatformId(`seed`);

        expect(id).toMatch(/^[0-9a-f]{12}$/);
        expect(devPlatformId(`seed`)).toBe(id);
        expect(webName(id)).toBe(`dev-${id}`);
        expect(apiName(id)).toBe(`api-dev-${id}`);
        expect(webOrigin(id, `sbx.intentic.dev`)).toBe(`https://dev-${id}.sbx.intentic.dev`);
        expect(apiOrigin(id, `sbx.intentic.dev`)).toBe(`https://api-dev-${id}.sbx.intentic.dev`);
        expect(accountEmail(id, `sbx.intentic.dev`)).toBe(`devplat-${id}@sbx.intentic.dev`);
    });

    it(`keeps clear of every label shape the platform or a daemon mints`, () => {
        const id = devPlatformId(`seed`);

        for (const label of [webName(id), apiName(id)]) {
            expect(label).not.toMatch(/^(sandbox|port|public|preview)-/);
        }
    });
});
