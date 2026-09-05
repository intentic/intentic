import { expect, test } from "vitest";
import { seeded } from "./sandbox-run.command.js";

/* The seed protocol, as arithmetic on pairs: the probe container's own environment carries nothing the runner
 * did not put there, so each of the three names reads as one of three instructions. The spawn-driven sibling
 * (sandbox-run.command.integration.test.ts) proves the same thing through a real `-e`; this pins the rules. */

const dumped: [string, string][] = [
    ["OWNER_EMAIL", "a@b.c"],
    ["SANDBOX_MEMORY", "10g"],
    ["SANDBOX_RUNTIME", "--privileged"],
];

test("absent seeds replay the old container's pairs untouched", () => {
    expect(seeded(dumped, {})).toEqual(dumped);
});

test("a seed with a value replaces the old pair: a fresh ask outranks what the container carried", () => {
    const pairs = seeded(dumped, { SANDBOX_MEMORY: "12g", SANDBOX_CPUS: "4" });
    expect(pairs.filter(([name]) => name === "SANDBOX_MEMORY")).toEqual([["SANDBOX_MEMORY", "12g"]]);
    expect(pairs).toContainEqual(["SANDBOX_CPUS", "4"]);
    // Everything not seeded is exactly as it was.
    expect(pairs).toContainEqual(["OWNER_EMAIL", "a@b.c"]);
    expect(pairs).toContainEqual(["SANDBOX_RUNTIME", "--privileged"]);
});

/* CLEARING is the shape only a deliberate `reshape … default` produces. The runners never forward a blank from
 * their own shell (ic drops one before it reaches the probe), so an empty value here is always an instruction:
 * back to the derived cap, no CPU ceiling, no owner directives. */
test("an empty seed clears the pair rather than reading as no seed", () => {
    const pairs = seeded(dumped, { SANDBOX_MEMORY: "", SANDBOX_RUNTIME: "   " });
    expect(pairs.map(([name]) => name)).not.toContain("SANDBOX_MEMORY");
    expect(pairs.map(([name]) => name)).not.toContain("SANDBOX_RUNTIME");
    expect(pairs).toEqual([["OWNER_EMAIL", "a@b.c"]]);
});

test("only the three standing asks are seedable: nothing else in the probe's env reaches the container", () => {
    const pairs = seeded(dumped, { PATH: "/usr/bin", CONNECT_TOKEN: "smuggled", SANDBOX_IMAGE: "other" });
    expect(pairs).toEqual(dumped);
});
