import { expect, test } from "vitest";
import { unstubbed } from "../testing.js";
import { createCloudflareProvider } from "./cloudflare.js";
import type { CloudflareApi } from "./cloudflare-api.js";

// Only the calls a suite asserts on are stubbed; anything else the provider reaches names itself.
const api = (overrides: Partial<CloudflareApi>): CloudflareApi => unstubbed("cloudflare", overrides);

const ctx = (log: (message: string) => void = () => {}) => ({
    env: {},
    log,
    id: "cf",
    output: () => {
        throw new Error("unused in cloudflare provider");
    },
});

const inputs = { apiToken: "token-xyz", zone: "example.com" };

test("read resolves the owned zone to its id and account", async () => {
    const provider = createCloudflareProvider(api({ getZone: async () => ({ id: "zone-abc", accountId: "acct-1" }) }));
    expect(await provider.read(inputs, ctx())).toEqual({ outputs: { zoneId: "zone-abc", accountId: "acct-1" } });
});

test("read returns undefined and logs when the zone is not found", async () => {
    const logs: string[] = [];
    const provider = createCloudflareProvider(api({ getZone: async () => undefined }));
    expect(
        await provider.read(
            inputs,
            ctx((message) => logs.push(message)),
        ),
    ).toBeUndefined();
    expect(logs.some((message) => message.includes("not found"))).toBe(true);
});

test("read propagates an API error", async () => {
    const provider = createCloudflareProvider(
        api({
            getZone: async () => {
                throw new Error("HTTP 403");
            },
        }),
    );
    await expect(provider.read(inputs, ctx())).rejects.toThrow(/403/);
});

test("apply returns the zone id and account when found", async () => {
    const provider = createCloudflareProvider(api({ getZone: async () => ({ id: "zone-abc", accountId: "acct-1" }) }));
    expect(await provider.apply(inputs, undefined, ctx())).toEqual({ zoneId: "zone-abc", accountId: "acct-1" });
});

test("apply throws when the owned zone does not exist", async () => {
    const provider = createCloudflareProvider(api({ getZone: async () => undefined }));
    await expect(provider.apply(inputs, undefined, ctx())).rejects.toThrow(/does not exist/);
});

test("diff is always noop for an owned zone", () => {
    const provider = createCloudflareProvider(api({}));
    expect(provider.diff(inputs, { outputs: {} })).toEqual({ action: "noop" });
});

test("the token and zone flow through to getZone", async () => {
    let captured: { apiToken: string; zone: string } | undefined;
    const provider = createCloudflareProvider(
        api({
            getZone: async (args) => {
                captured = args;
                return { id: "z", accountId: "a" };
            },
        }),
    );
    await provider.read(inputs, ctx());
    expect(captured).toEqual({ apiToken: "token-xyz", zone: "example.com" });
});

test("malformed inputs are rejected", async () => {
    const provider = createCloudflareProvider(api({}));
    await expect(provider.read({ zone: "z" }, ctx())).rejects.toThrow(/cloudflare inputs malformed/);
});
