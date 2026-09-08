import { beforeEach, expect, it, vi } from "vitest";
import { resolveTxtAuthoritatively } from "./authoritative-dns.js";

// Fake delegation: an apex with nameservers, names beneath it without, and per-nameserver TXT data — enough to exercise
// which zone gets asked and what counts as published.

const dns = vi.hoisted(() => ({
    // Only the apex carries NS records, as in a real delegation.
    ns: new Map<string, string[]>(),
    addresses: new Map<string, string[]>(),
    // nameserver address → record name → the TXT strings it serves
    txt: new Map<string, string[][]>(),
    nsQueries: [] as string[],
}));

vi.mock("node:dns/promises", () => {
    const notFound = (): never => {
        throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    };
    class Resolver {
        private servers: string[] = [];
        setServers(servers: string[]): void {
            this.servers = servers;
        }
        async resolveNs(name: string): Promise<string[]> {
            dns.nsQueries.push(name);
            return dns.ns.get(name) ?? notFound();
        }
        async resolve4(name: string): Promise<string[]> {
            return dns.addresses.get(name) ?? notFound();
        }
        async resolveTxt(_name: string): Promise<string[][]> {
            return dns.txt.get(this.servers[0] ?? "") ?? notFound();
        }
    }
    return { Resolver };
});

const RECORD = "_acme-challenge.0f310c3c4db4.local.intentic.dev";

beforeEach(() => {
    dns.ns.clear();
    dns.addresses.clear();
    dns.txt.clear();
    dns.nsQueries.length = 0;
    dns.ns.set("intentic.dev", ["one.ns.test", "two.ns.test"]);
    dns.addresses.set("one.ns.test", ["10.0.0.1"]);
    dns.addresses.set("two.ns.test", ["10.0.0.2"]);
});

it("asks the zone's own nameservers, found by walking up from the record", async () => {
    dns.txt.set("10.0.0.1", [["published"]]);
    dns.txt.set("10.0.0.2", [["published"]]);
    expect(await resolveTxtAuthoritatively(RECORD)).toEqual(["published"]);
    // Four steps, not three: the record carries an extra label (`<id>.local.<zone>`), the kind of change a walk
    // hardcoded to a fixed depth would break on.
    expect(dns.nsQueries).toEqual([RECORD, "0f310c3c4db4.local.intentic.dev", "local.intentic.dev", "intentic.dev"]);
});

it("reports only what EVERY nameserver serves, so a half-propagated zone reads as not yet published", async () => {
    dns.txt.set("10.0.0.1", [["published"]]);
    dns.txt.set("10.0.0.2", []);
    expect(await resolveTxtAuthoritatively(RECORD)).toEqual([]);
});

it("joins the strings a long TXT record arrives in", async () => {
    dns.txt.set("10.0.0.1", [["first", "second"]]);
    dns.txt.set("10.0.0.2", [["first", "second"]]);
    expect(await resolveTxtAuthoritatively(RECORD)).toEqual(["firstsecond"]);
});

it("reads a resolution failure as nothing published rather than an error", async () => {
    dns.ns.clear();
    expect(await resolveTxtAuthoritatively(RECORD)).toEqual([]);
});
