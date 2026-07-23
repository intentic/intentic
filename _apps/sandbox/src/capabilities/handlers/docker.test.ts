import { expect, test } from "vitest";
import { registry } from "../registry.js";
import { hasSysAdmin } from "./docker.js";

// The environment-dependent paths (docker info, /proc/self/status, the panel session) are exercised end-to-end;
// here we pin the two contracts other code trusts: the fragment's directive (what the rebuild executors
// allowlist and the composed overlay records) and the CapEff probe deciding "rebuild required" vs "start now".

test("the fragment is exactly the privileged runtime directive (the engine itself is baked in the base image)", () => {
    const fragment = registry.docker.fragment?.({}) ?? "";
    expect(fragment).toContain("# intentic:runtime --privileged");
    // Comment-only: no RUN/ENV — a docker rebuild is a cache-hit build, not an engine install.
    expect(fragment.split("\n").every((line) => line.trim() === "" || line.startsWith("#"))).toBe(true);
});

test("docker cannot be removed — de-privileging a sandbox with live engine state is not a silent toggle", () => {
    expect(registry.docker.remove).toBeUndefined();
});

test("hasSysAdmin reads CAP_SYS_ADMIN (bit 21) out of CapEff", () => {
    // A --privileged container: the full effective set.
    expect(hasSysAdmin("CapInh:\t0000000000000000\nCapEff:\t000001ffffffffff\n")).toBe(true);
    // Docker's default unprivileged cap set (no SYS_ADMIN).
    expect(hasSysAdmin("CapEff:\t00000000a80425fb\n")).toBe(false);
    // A plain user process / unreadable status.
    expect(hasSysAdmin("CapEff:\t0000000000000000\n")).toBe(false);
    expect(hasSysAdmin("")).toBe(false);
});
