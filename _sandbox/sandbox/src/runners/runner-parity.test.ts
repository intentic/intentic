import { expect, test } from "vitest";
import { runnerSlug } from "@intentic/sandbox-contract";
import { runnerParity } from "./runner-parity.js";

/* What a runner's row is allowed to say about its build. Every case here decides a badge and an update button,
 * and the two wrong answers cost opposite things: a false "outdated" nags about a machine that is fine, and a
 * false "current" leaves a runner months behind the parent looking healthy while its link errors read as
 * network trouble. */

const parent = { image: "ghcr.io/intentic/sandbox:2.3.1", channel: "stable", overlayHash: "abc123" };

test("a runner on the parent's image, channel and approved overlay is current", () => {
    expect(runnerParity(parent, { ...parent })).toBe("current");
});

test("any one axis moving is outdated, because each decides what code the turn runs", () => {
    expect(runnerParity(parent, { ...parent, image: "ghcr.io/intentic/sandbox:2.2.0" })).toBe("outdated");
    expect(runnerParity(parent, { ...parent, channel: "edge" })).toBe("outdated");
    expect(runnerParity(parent, { ...parent, overlayHash: "def456" })).toBe("outdated");
});

/* An overlay the owner added to the parent and not to the runner differs in exactly the way a turn notices,
 * when the tool it installed is missing. Neither side having one is agreement, not a gap. */
test("an overlay on one side only is a difference; neither side having one is not", () => {
    const stock = { image: parent.image, channel: parent.channel };
    expect(runnerParity({ ...stock }, { ...stock })).toBe("current");
    expect(runnerParity(parent, stock)).toBe("outdated");
    expect(runnerParity(stock, parent)).toBe("outdated");
});

/* UNKNOWN IS A REAL ANSWER, twice over: a runner that has never connected has told us nothing to compare, and
 * a dev parent cannot name its own image, so a warning drawn from either would be one nobody can act on. */
test("nothing to compare, or nothing to compare against, reads as unknown rather than as a warning", () => {
    expect(runnerParity(parent, undefined)).toBe("unknown");
    expect(runnerParity(parent, { image: "" })).toBe("unknown");
    expect(runnerParity({ image: "" }, { image: "dev" })).toBe("unknown");
    expect(runnerParity({ image: "dev" }, { image: "dev" })).toBe("unknown");
});

/* The container name the update and rebuild flows address a runner by. It has to be `ic`'s own spelling
 * (runner.rs SLUG_PREFIX): a mismatch sends the flow at a container that does not exist and reports "no such
 * sandbox" about a runner sitting right there in the list. */
test("a runner's container is its name under ic's prefix", () => {
    expect(runnerSlug("rig")).toBe("runner-rig");
});
