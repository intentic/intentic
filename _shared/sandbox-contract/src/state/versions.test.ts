import { compareVersions, DEV_VERSION, isBehind, isNewer, parseVersion } from "./versions.js";

test("isNewer compares dotted numeric versions", () => {
    expect(isNewer("1.3.0", "1.2.9")).toBe(true); // newer minor
    expect(isNewer("1.2.10", "1.2.9")).toBe(true); // numeric, not lexical
    expect(isNewer("2.0.0", "1.9.9")).toBe(true); // newer major
    expect(isNewer("1.2.3", "1.2.3")).toBe(false); // equal
    expect(isNewer("1.2.2", "1.2.3")).toBe(false); // older
    expect(isNewer("1.2", "1.2.0")).toBe(false); // missing segment treated as 0
});

test("isBehind reports a released build that a newer release has passed", () => {
    expect(isBehind("1.182.0", "1.183.0")).toBe(true);
    expect(isBehind("1.183.0", "1.183.0")).toBe(false);
    expect(isBehind("1.184.0", "1.183.0")).toBe(false); // ahead of what this sandbox knows about
});

// Every way of not knowing resolves to silence. Each of these once had a plausible argument for nagging, and
// each would have nagged somebody who could do nothing about it.
test("isBehind stays quiet whenever it cannot be sure", () => {
    expect(isBehind(undefined, "1.183.0")).toBe(false); // the agent reports no version
    expect(isBehind("1.182.0", undefined)).toBe(false); // this sandbox has no latest to compare against
    expect(isBehind(DEV_VERSION, "1.183.0")).toBe(false); // a build made from a working tree, not a release
});

/* A version with a segment that will not parse is read by its numeric prefix, and the failure is one-directional: it can withhold a nag, never invent one. */
test("a version that isn't dotted-numeric can only ever withhold the nudge", () => {
    expect(isBehind("1.2.0-rc.1", "1.183.0")).toBe(true); // the prefix already decides it: 2 is behind 183
    expect(isBehind("1.2.0-rc.1", "1.2.0")).toBe(false); // the unparseable segment is where they differ — silence
});

// The version every agent shipped before the release stamp existed. It is genuinely behind: it predates every
// release that has one, and it must read that way, because those are the installs this whole signal is for.
test("isBehind flags the hand-written version agents used to carry", () => {
    expect(isBehind("0.1.0", "1.183.0")).toBe(true);
});

test("compareVersions puts a release ahead of its own prereleases", () => {
    expect(compareVersions("1.2.0", "1.2.0-rc.1")).toBe(1);
    expect(compareVersions("1.2.0-rc.1", "1.2.0")).toBe(-1);
    expect(compareVersions("1.2.0-rc.2", "1.2.0-rc.1")).toBe(1);
    expect(compareVersions("1.2.0-rc.10", "1.2.0-rc.9")).toBe(1); // numeric identifiers numerically
    expect(compareVersions("1.2.0-rc.1.1", "1.2.0-rc.1")).toBe(1); // more identifiers, equal so far, is later
    expect(compareVersions("1.2.0-1", "1.2.0-alpha")).toBe(-1); // a number sorts below a word
    expect(compareVersions("1.1.9", "1.2.0-rc.1")).toBe(-1); // the core decides before the prerelease
});

test("compareVersions tolerates a leading v and ignores build metadata", () => {
    expect(compareVersions("v1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("V2.0.0", "v2.0.0")).toBe(0);
    expect(compareVersions("1.2.0+build.5", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
});

test("compareVersions sorts anything unparseable below every version", () => {
    expect(compareVersions("unknown", "0.0.1")).toBe(-1);
    expect(compareVersions("1.0.0", "")).toBe(1);
    expect(compareVersions("latest", "unknown")).toBe(0);
    expect(["1.2.0-rc.1", "unknown", "1.10.0", "v1.2.0"].sort((a, b) => compareVersions(b, a))).toEqual(["1.10.0", "v1.2.0", "1.2.0-rc.1", "unknown"]);
});

test("parseVersion reads the parts and the prerelease", () => {
    expect(parseVersion("v1.2.3-rc.1+abc")).toEqual({ parts: [1, 2, 3], prerelease: ["rc", "1"] });
    expect(parseVersion("1.x")).toBe(undefined);
});
