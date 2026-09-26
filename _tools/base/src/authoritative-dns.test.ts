import { resolveTxtAuthoritatively } from "./authoritative-dns.js";

// Fake delegation: an apex with nameservers, names beneath it without, and per-nameserver TXT data — enough to exercise
// which zone gets asked and what counts as published.

const dns = {
    // Only the apex carries NS records, as in a real delegation.
    ns: new Map<string, string[]>(),
    addresses: new Map<string, string[]>(),
    // nameserver address → record name → the TXT strings it serves
    txt: new Map<string, string[][]>(),
    // nameserver addresses that never answer, as behind a network that blocks direct DNS
    silent: new Set<string>(),
    nsQueries: [] as string[],
};

jest.mock("node:dns/promises", () => {
    const notFound = (): never => {
        throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    };
    const timedOut = (): never => {
        throw Object.assign(new Error("ETIMEOUT"), { code: "ETIMEOUT" });
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
            const server = this.servers[0] ?? "";
            return dns.silent.has(server) ? timedOut() : (dns.txt.get(server) ?? notFound());
        }
    }
    return { Resolver };
});

const RECORD = "_acme-challenge.0f310c3c4db4.local.intentic.dev";

beforeEach(() => {
    dns.ns.clear();
    dns.addresses.clear();
    dns.txt.clear();
    dns.silent.clear();
    dns.nsQueries.length = 0;
    dns.ns.set("intentic.dev", ["one.ns.test", "two.ns.test"]);
    dns.addresses.set("one.ns.test", ["10.0.0.1"]);
    dns.addresses.set("two.ns.test", ["10.0.0.2"]);
});

it("asks the zone's own nameservers, found by walking up from the record", async () => {
    dns.txt.set("10.0.0.1", [["published"]]);
    dns.txt.set("10.0.0.2", [["published"]]);
    expect(await resolveTxtAuthoritatively(RECORD)).toEqual({ values: ["published"], reached: "all" });
    // Four steps, not three: the record carries an extra label (`<id>.local.<zone>`), the kind of change a walk
    // hardcoded to a fixed depth would break on.
    expect(dns.nsQueries).toEqual([RECORD, "0f310c3c4db4.local.intentic.dev", "local.intentic.dev", "intentic.dev"]);
});

it("reports only what EVERY nameserver serves, so a half-propagated zone reads as not yet published", async () => {
    dns.txt.set("10.0.0.1", [["published"]]);
    dns.txt.set("10.0.0.2", []);
    expect(await resolveTxtAuthoritatively(RECORD)).toEqual({ values: [], reached: "all" });
});

it("joins the strings a long TXT record arrives in", async () => {
    dns.txt.set("10.0.0.1", [["first", "second"]]);
    dns.txt.set("10.0.0.2", [["first", "second"]]);
    expect(await resolveTxtAuthoritatively(RECORD)).toEqual({ values: ["firstsecond"], reached: "all" });
});

it("reads a resolution failure as nothing published rather than an error", async () => {
    dns.ns.clear();
    expect(await resolveTxtAuthoritatively(RECORD)).toEqual({ values: [], reached: "none" });
});

it("tells a nameserver answering no such record apart from one that never answers", async () => {
    dns.txt.set("10.0.0.1", [["published"]]);
    expect(await resolveTxtAuthoritatively(RECORD)).toEqual({ values: [], reached: "all" });
    dns.silent.add("10.0.0.2");
    expect(await resolveTxtAuthoritatively(RECORD)).toEqual({ values: [], reached: "some" });
    dns.silent.add("10.0.0.1");
    expect(await resolveTxtAuthoritatively(RECORD)).toEqual({ values: [], reached: "none" });
});
