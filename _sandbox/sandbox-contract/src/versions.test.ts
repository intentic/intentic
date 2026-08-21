import { expect, test } from "vitest";
import { DEV_VERSION, isBehind, isNewer } from "./versions.js";

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

/* A version with a segment that will not parse is read by its numeric prefix, and the failure is one-directional:
 * it can withhold a nag, never invent one. Both halves are pinned because only the second is a safety property:
 * the first is just the prefix doing its job. */
test("a version that isn't dotted-numeric can only ever withhold the nudge", () => {
    expect(isBehind("1.2.0-rc.1", "1.183.0")).toBe(true); // the prefix already decides it: 2 is behind 183
    expect(isBehind("1.2.0-rc.1", "1.2.0")).toBe(false); // the unparseable segment is where they differ — silence
});

// The version every agent shipped before the release stamp existed. It is genuinely behind: it predates every
// release that has one, and it must read that way, because those are the installs this whole signal is for.
test("isBehind flags the hand-written version agents used to carry", () => {
    expect(isBehind("0.1.0", "1.183.0")).toBe(true);
});
