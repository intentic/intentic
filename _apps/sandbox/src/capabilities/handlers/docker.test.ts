import { expect, test } from "vitest";
import { registry } from "../registry.js";
import { isPrivileged } from "./docker.js";

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

test("isPrivileged reads CAP_SYS_MODULE (bit 16) out of CapEff", () => {
    // A --privileged container: the full effective set.
    expect(isPrivileged("CapInh:\t0000000000000000\nCapEff:\t000001ffffffffff\n")).toBe(true);
    // THE case this probe exists for, read off a live unprivileged sandbox: Docker's default set (a80425fb) plus
    // SANDBOX_CAPABILITIES' SYS_ADMIN (bit 21) and SYS_PTRACE (bit 19). A SYS_ADMIN probe says "privileged" here
    // and the capability never asks for the rebuild it needs.
    expect(isPrivileged("CapEff:\t00000000a82c25fb\n")).toBe(false);
    // Docker's default unprivileged cap set.
    expect(isPrivileged("CapEff:\t00000000a80425fb\n")).toBe(false);
    // The vpn capability's grant — NET_ADMIN (bit 12) on top of the sandbox set — is still not privileged.
    expect(isPrivileged("CapEff:\t00000000a82c35fb\n")).toBe(false);
    // A plain user process / unreadable status.
    expect(isPrivileged("CapEff:\t0000000000000000\n")).toBe(false);
    expect(isPrivileged("")).toBe(false);
});
