import { hostAllowed, hostMatches, normalizeHost, normalizeHostPattern, tightensHostGuard } from "../secret-hosts.js";

// The pattern a person writes against the host a use would reach. Every boundary a limit turns on is pinned by value:
// the apex a wildcard leaves out, the look-alike that only shares a suffix, and which edits take hosts away.

describe("normalizeHostPattern", () => {
    it("reads what a person types or pastes as the host it means", () => {
        expect(normalizeHostPattern("  API.GitHub.com. ")).toBe("api.github.com");
        expect(normalizeHostPattern("https://api.github.com/user?per_page=5")).toBe("api.github.com");
        expect(normalizeHostPattern("api.github.com:443")).toBe("api.github.com");
        expect(normalizeHostPattern("*.githubusercontent.com")).toBe("*.githubusercontent.com");
        expect(normalizeHostPattern("localhost")).toBe("localhost");
        expect(normalizeHostPattern("10.0.0.2")).toBe("10.0.0.2");
    });

    it("refuses what is not one host or one domain's hosts", () => {
        expect(normalizeHostPattern("*")).toBeUndefined();
        expect(normalizeHostPattern("*.com")).toBeUndefined();
        expect(normalizeHostPattern("api.*.com")).toBeUndefined();
        expect(normalizeHostPattern("api.github.com/user")).toBeUndefined();
        expect(normalizeHostPattern("user@api.github.com")).toBeUndefined();
        expect(normalizeHostPattern("-bad.example.com")).toBeUndefined();
        expect(normalizeHostPattern("")).toBeUndefined();
        expect(normalizeHostPattern(`${"a".repeat(64)}.com`)).toBeUndefined();
    });
});

describe("normalizeHost", () => {
    it("takes a plain host or address and nothing shaped like a pattern or a stray token", () => {
        expect(normalizeHost("API.github.com.")).toBe("api.github.com");
        expect(normalizeHost("*.github.com")).toBeUndefined();
        expect(normalizeHost("[::1]")).toBeUndefined();
        expect(normalizeHost("api.github.com\u0001")).toBeUndefined();
        expect(normalizeHost("$host")).toBeUndefined();
    });
});

describe("hostMatches", () => {
    it("matches an exact host only to itself", () => {
        expect(hostMatches("api.github.com", "api.github.com")).toBe(true);
        expect(hostMatches("api.github.com", "github.com")).toBe(false);
        expect(hostMatches("github.com", "api.github.com")).toBe(false);
    });

    it("matches a wildcard to every host under the domain, at any depth, and not to the domain itself", () => {
        expect(hostMatches("*.github.com", "api.github.com")).toBe(true);
        expect(hostMatches("*.github.com", "a.b.github.com")).toBe(true);
        expect(hostMatches("*.github.com", "github.com")).toBe(false);
    });

    it("does not match a host that merely ends in the same letters", () => {
        expect(hostMatches("*.github.com", "evilgithub.com")).toBe(false);
        expect(hostMatches("*.github.com", "github.com.evil.example")).toBe(false);
    });

    it("allows a host any one pattern in the list matches", () => {
        expect(hostAllowed(["api.github.com", "*.githubusercontent.com"], "raw.githubusercontent.com")).toBe(true);
        expect(hostAllowed(["api.github.com", "*.githubusercontent.com"], "evil.example")).toBe(false);
        expect(hostAllowed([], "api.github.com")).toBe(false);
    });
});

describe("tightensHostGuard", () => {
    const on = (...hosts: string[]) => ({ guard: true, hosts });
    const off = (...hosts: string[]) => ({ guard: false, hosts });

    it("reads turning the guard on as tightening, whatever the list, and turning it off as loosening", () => {
        expect(tightensHostGuard(undefined, on("api.github.com"))).toBe(true);
        expect(tightensHostGuard(off("api.github.com"), on())).toBe(true);
        expect(tightensHostGuard(on("api.github.com"), off("api.github.com"))).toBe(false);
        expect(tightensHostGuard(undefined, off())).toBe(true);
        expect(tightensHostGuard(off(), off("evil.example"))).toBe(true);
    });

    it("reads taking a host off a guarded list as tightening, down to none, and adding one as loosening", () => {
        expect(tightensHostGuard(on("api.github.com", "github.com"), on("github.com"))).toBe(true);
        expect(tightensHostGuard(on("api.github.com"), on())).toBe(true);
        expect(tightensHostGuard(on("api.github.com"), on("api.github.com", "evil.example"))).toBe(false);
        expect(tightensHostGuard(on(), on("api.github.com"))).toBe(false);
        expect(tightensHostGuard(on("api.github.com"), on("api.github.com"))).toBe(true);
    });

    it("counts a host or a deeper wildcard under a held wildcard as covered, and the domain itself as not", () => {
        expect(tightensHostGuard(on("*.github.com"), on("api.github.com"))).toBe(true);
        expect(tightensHostGuard(on("*.github.com"), on("*.api.github.com"))).toBe(true);
        expect(tightensHostGuard(on("*.github.com"), on("github.com"))).toBe(false);
        expect(tightensHostGuard(on("api.github.com"), on("*.api.github.com"))).toBe(false);
    });
});
