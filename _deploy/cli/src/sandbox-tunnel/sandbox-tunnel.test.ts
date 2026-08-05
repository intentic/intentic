import { createHash } from "node:crypto";
import type { CloudflareApi } from "@intentic/providers";
import { describe, expect, test, vi } from "vitest";
import { createSandboxTunnel } from "./sandbox-tunnel.js";

// A fully-stubbed Cloudflare client; tests override only the methods they exercise.
const fakeApi = (overrides: Partial<CloudflareApi> = {}): CloudflareApi => ({
    getZone: async () => undefined,
    listZones: async () => [],
    findTunnel: async () => undefined,
    createTunnel: async () => ({ id: "tunnel-1" }),
    getTunnelToken: async () => "connector-token",
    getTunnelStatus: async () => "healthy",
    getTunnelIngress: async () => undefined,
    putTunnelIngress: async () => {},
    findDnsRecord: async () => undefined,
    createDnsRecord: async () => {},
    updateDnsRecord: async () => {},
    deleteTunnel: async () => {},
    deleteDnsRecord: async () => {},
    listStampedDnsRecords: async () => [],
    ...overrides,
});

const noop = (): void => {};
const idOf = (connectToken: string): string => createHash("sha256").update(connectToken).digest("hex").slice(0, 12);

describe("createSandboxTunnel", () => {
    test("single zone: creates the tunnel + proxied DNS and returns the connector token + hostname", async () => {
        const putTunnelIngress = vi.fn(async () => {});
        const createDnsRecord = vi.fn(async () => {});
        const api = fakeApi({
            listZones: async () => [{ id: "zone-1", name: "example.com", accountId: "acct-1" }],
            getTunnelToken: async () => "the-token",
            putTunnelIngress,
            createDnsRecord,
        });
        const hostname = `sandbox-${idOf("conn")}.example.com`;
        const result = await createSandboxTunnel({
            apiToken: "t",
            connectToken: "conn",
            service: "http://intentic-sandbox-workspace:8787",
            log: noop,
            api,
        });
        expect(result).toEqual({ token: "the-token", hostname });
        expect(putTunnelIngress).toHaveBeenCalledWith(
            expect.objectContaining({
                ingress: [{ hostname, service: "http://intentic-sandbox-workspace:8787" }, { service: "http_status:404" }],
            }),
        );
        expect(createDnsRecord).toHaveBeenCalledWith(expect.objectContaining({ name: hostname, content: "tunnel-1.cfargotunnel.com" }));
    });

    test("with previewService, also routes the *.<zone> wildcard and creates its DNS record", async () => {
        const putTunnelIngress = vi.fn(async () => {});
        const createDnsRecord = vi.fn(async () => {});
        const api = fakeApi({
            listZones: async () => [{ id: "zone-1", name: "example.com", accountId: "acct-1" }],
            putTunnelIngress,
            createDnsRecord,
        });
        const hostname = `sandbox-${idOf("conn")}.example.com`;
        await createSandboxTunnel({
            apiToken: "t",
            connectToken: "conn",
            service: "http://sb:8787",
            previewService: "http://sb:5173",
            log: noop,
            api,
        });
        expect(putTunnelIngress).toHaveBeenCalledWith(
            expect.objectContaining({
                ingress: [
                    { hostname, service: "http://sb:8787" },
                    { hostname: "*.example.com", service: "http://sb:5173" },
                    { service: "http_status:404" },
                ],
            }),
        );
        expect(createDnsRecord).toHaveBeenCalledWith(expect.objectContaining({ name: "*.example.com" }));
    });

    test("uses the zone override (and never lists zones) when one is given", async () => {
        const getZone = vi.fn(async () => ({ id: "z", accountId: "a" }));
        const api = fakeApi({
            getZone,
            listZones: async () => {
                throw new Error("should not list zones when an override is given");
            },
        });
        const result = await createSandboxTunnel({ apiToken: "t", connectToken: "conn", service: "s", zone: "my.dev", log: noop, api });
        expect(getZone).toHaveBeenCalledWith({ apiToken: "t", zone: "my.dev" });
        expect(result.hostname).toBe(`sandbox-${idOf("conn")}.my.dev`);
    });

    test("uses an explicit subdomain in place of the derived sandbox-<id>", async () => {
        const putTunnelIngress = vi.fn(async () => {});
        const createDnsRecord = vi.fn(async () => {});
        const api = fakeApi({
            listZones: async () => [{ id: "zone-1", name: "example.com", accountId: "acct-1" }],
            putTunnelIngress,
            createDnsRecord,
        });
        const result = await createSandboxTunnel({
            apiToken: "t",
            connectToken: "conn",
            service: "http://sb:8787",
            subdomain: "my-box",
            log: noop,
            api,
        });
        expect(result.hostname).toBe("my-box.example.com");
        expect(putTunnelIngress).toHaveBeenCalledWith(
            expect.objectContaining({ ingress: [{ hostname: "my-box.example.com", service: "http://sb:8787" }, { service: "http_status:404" }] }),
        );
        expect(createDnsRecord).toHaveBeenCalledWith(expect.objectContaining({ name: "my-box.example.com", content: "tunnel-1.cfargotunnel.com" }));
    });

    test("errors when the override zone is not found", async () => {
        const api = fakeApi({ getZone: async () => undefined });
        await expect(createSandboxTunnel({ apiToken: "t", connectToken: "c", service: "s", zone: "nope.dev", log: noop, api })).rejects.toThrow(
            /not found/,
        );
    });

    test("multiple zones, no override: lists them and names ZONE/--zone with a concrete example", async () => {
        const api = fakeApi({
            listZones: async () => [
                { id: "1", name: "a.com", accountId: "x" },
                { id: "2", name: "b.com", accountId: "x" },
            ],
        });
        const error = await createSandboxTunnel({ apiToken: "t", connectToken: "c", service: "s", log: noop, api }).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("a.com, b.com");
        expect((error as Error).message).toContain("ZONE");
        expect((error as Error).message).toContain("--zone a.com");
    });

    test("no zones: error guides toward adding a domain or broadening the token scope", async () => {
        const error = await createSandboxTunnel({ apiToken: "t", connectToken: "c", service: "s", log: noop, api: fakeApi() }).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/no zones/);
        expect((error as Error).message).toMatch(/Zone:Read/);
    });

    test("idempotent: reuses an existing tunnel and updates the existing DNS record", async () => {
        const createTunnel = vi.fn(async () => ({ id: "should-not-create" }));
        const createDnsRecord = vi.fn(async () => {});
        const updateDnsRecord = vi.fn(async () => {});
        const api = fakeApi({
            listZones: async () => [{ id: "zone-1", name: "example.com", accountId: "acct-1" }],
            findTunnel: async () => ({ id: "existing-tunnel" }),
            findDnsRecord: async () => ({ id: "rec-1", content: "old.cfargotunnel.com" }),
            createTunnel,
            createDnsRecord,
            updateDnsRecord,
        });
        await createSandboxTunnel({ apiToken: "t", connectToken: "conn", service: "s", log: noop, api });
        expect(createTunnel).not.toHaveBeenCalled();
        expect(createDnsRecord).not.toHaveBeenCalled();
        expect(updateDnsRecord).toHaveBeenCalledWith(expect.objectContaining({ recordId: "rec-1", content: "existing-tunnel.cfargotunnel.com" }));
    });
});
