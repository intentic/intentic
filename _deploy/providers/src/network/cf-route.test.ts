import { expect, test } from "vitest";

import { unstubbed } from "@intentic/testing";
import { createCfRouteProvider } from "./cf-route.js";
import type { CloudflareApi } from "./cloudflare-api.js";

// Only the calls a suite asserts on are stubbed; anything else the provider reaches names itself.
const api = (overrides: Partial<CloudflareApi>): CloudflareApi => unstubbed("cloudflare", overrides);

const ctx = () => ({
    env: {},
    log: () => {},
    id: "cf-app-example-com",
    output: () => {
        throw new Error("unused in cf-route provider");
    },
});

const inputs = { hostname: "app.example.com", zoneId: "zone-1", apiToken: "tok", cname: "tunnel-abc.cfargotunnel.com" };

test("read returns undefined when no record exists", async () => {
    const provider = createCfRouteProvider(api({ findDnsRecord: async () => undefined }));
    expect(await provider.read(inputs, ctx())).toBeUndefined();
});

test("read returns the route url plus the record's current target", async () => {
    const provider = createCfRouteProvider(api({ findDnsRecord: async () => ({ id: "rec-1", content: "tunnel-abc.cfargotunnel.com" }) }));
    expect(await provider.read(inputs, ctx())).toEqual({
        outputs: { url: "https://app.example.com" },
        detail: { content: "tunnel-abc.cfargotunnel.com" },
    });
});

// On a fresh plan the tunnel is a pending create, so cname (a $ref to its output) resolves to the engine's
// PENDING symbol; zoneId can be PENDING too when the cf node itself is pending. read/diff must tolerate both:
// this is the exact crash that broke every fresh-setup preview ("expected string, received symbol").
const PENDING_LIKE = Symbol("pending-output");

test("read tolerates a PENDING cname: it never parses the field it doesn't use", async () => {
    const provider = createCfRouteProvider(api({ findDnsRecord: async () => undefined }));
    expect(await provider.read({ ...inputs, cname: PENDING_LIKE }, ctx())).toBeUndefined();
});

test("read returns undefined on a PENDING zoneId: the zone is itself a pending create", async () => {
    const provider = createCfRouteProvider(api({}));
    expect(await provider.read({ ...inputs, zoneId: PENDING_LIKE }, ctx())).toBeUndefined();
});

test("diff on a PENDING cname reports drift with a reason instead of crashing", () => {
    const provider = createCfRouteProvider(api({}));
    const result = provider.diff({ ...inputs, cname: PENDING_LIKE }, { outputs: {}, detail: { content: "old.cfargotunnel.com" } });
    expect(result).toMatchObject({ action: "update" });
    expect(result.action === "update" && result.reason).toContain("not derivable");
});

test("diff is noop when the CNAME already targets the tunnel", () => {
    const provider = createCfRouteProvider(api({}));
    expect(provider.diff(inputs, { outputs: {}, detail: { content: "tunnel-abc.cfargotunnel.com" } })).toEqual({ action: "noop" });
});

test("diff is update when the CNAME target drifts", () => {
    const provider = createCfRouteProvider(api({}));
    expect(provider.diff(inputs, { outputs: {}, detail: { content: "stale.cfargotunnel.com" } }).action).toBe("update");
});

const noPropagationWait = async (): Promise<void> => {};

test("apply creates a proxied CNAME stamped with the resource id when absent", async () => {
    let created: { name: string; content: string; comment: string } | undefined;
    const provider = createCfRouteProvider(
        api({
            findDnsRecord: async () => undefined,
            createDnsRecord: async (args) => {
                created = { name: args.name, content: args.content, comment: args.comment };
            },
        }),
        noPropagationWait,
    );
    expect(await provider.apply(inputs, undefined, ctx())).toEqual({ url: "https://app.example.com" });
    expect(created).toEqual({ name: "app.example.com", content: "tunnel-abc.cfargotunnel.com", comment: "intentic.id=cf-app-example-com" });
});

test("apply updates the existing record by id", async () => {
    let updatedId: string | undefined;
    const provider = createCfRouteProvider(
        api({
            findDnsRecord: async () => ({ id: "rec-9", content: "stale.cfargotunnel.com" }),
            updateDnsRecord: async (args) => {
                updatedId = args.recordId;
            },
        }),
        noPropagationWait,
    );
    await provider.apply(inputs, undefined, ctx());
    expect(updatedId).toBe("rec-9");
});

test("malformed inputs are rejected", async () => {
    const provider = createCfRouteProvider(api({}));
    await expect(provider.read({ hostname: "h", zoneId: "z" }, ctx())).rejects.toThrow(/cf-route inputs malformed/);
});
