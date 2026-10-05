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

test("apply stamps the owner first in the record comment when the run has one", async () => {
    let comment: string | undefined;
    const provider = createCfRouteProvider(
        api({
            findDnsRecord: async () => undefined,
            createDnsRecord: async (args) => {
                comment = args.comment;
            },
        }),
        noPropagationWait,
    );
    await provider.apply(inputs, undefined, { ...ctx(), owner: "3f9a1c2b7d4e" });
    expect(comment).toBe("intentic.owner=3f9a1c2b7d4e intentic.id=cf-app-example-com");
});

test("read reports the record's owner stamp, empty for a legacy comment, and nothing when the run has no owner", async () => {
    const reading = (comment: string) =>
        createCfRouteProvider(api({ findDnsRecord: async () => ({ id: "rec-1", content: "tunnel-abc.cfargotunnel.com", comment }) }));
    const owned = { ...ctx(), owner: "aaa" };
    expect((await reading("intentic.owner=aaa intentic.id=cf-app-example-com").read(inputs, owned))?.stampOwner).toBe("aaa");
    expect((await reading("intentic.owner=bbb intentic.id=cf-app-example-com").read(inputs, owned))?.stampOwner).toBe("bbb");
    expect((await reading("intentic.id=cf-app-example-com").read(inputs, owned))?.stampOwner).toBe("");
    expect(await reading("intentic.id=cf-app-example-com").read(inputs, ctx())).not.toHaveProperty("stampOwner");
});

test("a route whose owned comment would pass Cloudflare's 100-character cap keeps the legacy stamp and is not owner-checked", async () => {
    let comment: string | undefined;
    const longId = `cf-${"a".repeat(70)}`;
    const provider = createCfRouteProvider(
        api({
            findDnsRecord: async () => ({ id: "rec-1", content: "tunnel-abc.cfargotunnel.com", comment: `intentic.id=${longId}` }),
            updateDnsRecord: async (args) => {
                comment = args.comment;
            },
        }),
        noPropagationWait,
    );
    const longCtx = { ...ctx(), id: longId, owner: "3f9a1c2b7d4e" };
    expect(await provider.read(inputs, longCtx)).not.toHaveProperty("stampOwner");
    await provider.apply(inputs, undefined, longCtx);
    expect(comment).toBe(`intentic.id=${longId}`);
});

test("list scans both stamp forms and returns each record's owner, skipping comments that are not stamps", async () => {
    const prefixes: string[] = [];
    const provider = createCfRouteProvider(
        api({
            getZone: async () => ({ id: "zone-1", accountId: "acct" }),
            listStampedDnsRecords: async ({ commentPrefix }) => {
                prefixes.push(commentPrefix);
                return commentPrefix === "intentic.id="
                    ? [{ name: "old.example.com", comment: "intentic.id=cf-old" }]
                    : [
                          { name: "mine.example.com", comment: "intentic.owner=aaa intentic.id=cf-mine" },
                          { name: "odd.example.com", comment: "intentic.owner=aaa but not a stamp" },
                      ];
            },
        }),
    );
    const sources = [{ id: "cf", type: "cloudflare" as const, inputs: { apiToken: "tok", zone: "example.com" } }];
    const listed = await provider.list?.(sources, ctx());
    expect(prefixes).toEqual(["intentic.id=", "intentic.owner="]);
    expect(listed).toEqual([
        { id: "cf-old", inputs: { hostname: "old.example.com", zoneId: "zone-1", apiToken: "tok" } },
        { id: "cf-mine", inputs: { hostname: "mine.example.com", zoneId: "zone-1", apiToken: "tok" }, owner: "aaa" },
    ]);
});

test("list reports a zone it cannot find as a skipped source, not as an empty zone", async () => {
    const skipped: string[] = [];
    const provider = createCfRouteProvider(api({ getZone: async () => undefined }));
    const sources = [{ id: "cf", type: "cloudflare" as const, inputs: { apiToken: "tok", zone: "example.com" } }];
    expect(await provider.list?.(sources, { ...ctx(), skipped: (source, reason) => skipped.push(`${source}: ${reason}`) })).toEqual([]);
    expect(skipped).toEqual(['cf: zone "example.com" not found']);
});
