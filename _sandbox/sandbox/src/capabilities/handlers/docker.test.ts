import { expect, test } from "vitest";
import { packFragment, readPack } from "../../environment/packs.js";
import { registry } from "../registry.js";
import { addressPoolOf, isPrivileged, withEngineSettings } from "./docker.js";

// The environment-dependent paths (docker info, /proc/self/status, the panel session) are exercised end-to-end;
// here we pin the two contracts other code trusts: the fragment's directive (what the rebuild executors
// allowlist and the composed overlay records) and the CapEff probe deciding "rebuild required" vs "start now".

test("the fragment carries the privileged directive plus the engine pack when the base image lacks it", async () => {
    const fragment = (await registry.docker.fragment?.({})) ?? "";
    expect(fragment).toContain("# intentic:runtime --privileged");
    // The engine half is the docker pack, and WHETHER it rides depends on the image the suite runs in — a
    // core image (or a dev checkout) composes the install, a standard image (stamped base) yields the
    // directive alone, a cache-hit rebuild. Both are the contract, so the install is pinned against the
    // pack's own content and its presence against the stamp, rather than against wherever this happens to run.
    expect((await readPack("docker"))!.content).toContain("docker-ce");
    const engine = await packFragment("docker");
    expect(fragment.includes("docker-ce")).toBe(engine !== undefined);
});

/* The gpu option's fragment has to satisfy BOTH layers or the option is a lie: the directive gets the devices
 * as far as this container, and the toolkit registers the nvidia runtime with the dockerd running INSIDE it.
 * With only the first, the agent's `docker compose up` still dies on `could not select device driver "nvidia"`
 * in a container that can see the GPU — which is the exact failure this whole option exists to end. */
test("the gpu option adds the passthrough directive AND the toolkit the nested engine needs", async () => {
    const fragment = (await registry.docker.fragment?.({ gpu: "on" })) ?? "";
    expect(fragment).toContain("# intentic:runtime --privileged");
    expect(fragment).toContain("# intentic:runtime --gpus=all");
    expect(fragment).toContain("nvidia-container-toolkit");
    expect(fragment).toContain("nvidia-ctk runtime configure");
});

// Off is the default and the absence is total: an overlay that never asked must not carry a directive a host
// could refuse, so a sandbox on a GPU-less machine keeps starting exactly as it did.
test("gpu off leaves no trace in the fragment", async () => {
    for (const config of [{}, { gpu: "off" }]) {
        expect((await registry.docker.fragment?.(config)) ?? "").not.toContain("--gpus");
    }
});

// The echo is what the browser may see of a config — and what re-opening the card pre-fills its controls from.
test("the echo carries every option, so the card opens on what the user actually set", () => {
    expect(registry.docker.echo({ gpu: "on", registryMirror: "https://mirror.example" }, new Map())).toEqual({
        gpu: true,
        registryMirror: "https://mirror.example",
        insecureRegistries: "",
        addressPool: "",
    });
    expect(registry.docker.echo({}, new Map())).toEqual({ gpu: false, registryMirror: "", insecureRegistries: "", addressPool: "" });
});

/* THE FAMILY SPLIT, which is the difference between a five-second change and a five-minute one. An engine
 * option that leaked into the fragment would change the overlay's hash and so demand an owner-approved rebuild
 * for a value dockerd rereads every time it starts. This test is the guard on that; the daemon.json half is
 * `withEngineSettings` below. */
test("engine options never touch the fragment — only the image family costs a rebuild", async () => {
    const engine = { registryMirror: "https://mirror.example", insecureRegistries: "registry.lan:5000", addressPool: "10.201.0.0/16" };
    expect(await registry.docker.fragment?.(engine)).toBe(await registry.docker.fragment?.({}));
});

/* MERGED, never written over: the GPU fragment's `nvidia-ctk runtime configure` writes its runtime into this
 * same file at build time, so a wholesale write would un-register the nvidia runtime the first time somebody
 * set a registry mirror — turning the GPU option off from the inside, with no diff and no message. */
test("engine settings merge into daemon.json and leave what they don't own alone", () => {
    const existing = { runtimes: { nvidia: { path: "nvidia-container-runtime" } }, "log-level": "warn" };
    const merged = withEngineSettings(existing, {
        registryMirror: "https://mirror.example",
        insecureRegistries: "registry.lan:5000, other.lan:5000",
        addressPool: "10.201.0.0/16",
    });
    expect(merged["runtimes"]).toEqual(existing.runtimes);
    expect(merged["log-level"]).toBe("warn");
    expect(merged["registry-mirrors"]).toEqual(["https://mirror.example"]);
    // One field, pasted as people paste lists — commas and whitespace both separate.
    expect(merged["insecure-registries"]).toEqual(["registry.lan:5000", "other.lan:5000"]);
    expect(merged["default-address-pools"]).toEqual([{ base: "10.201.0.0/16", size: 24 }]);
});

// Clearing a field has to REMOVE the key: left behind, a mirror the user deleted from the form would go on
// serving every pull, and the only evidence would be inside a file nobody thinks to open.
test("clearing an engine option deletes its key rather than leaving the old value", () => {
    const withSettings = withEngineSettings({}, { registryMirror: "https://mirror.example", addressPool: "10.201.0.0/16" });
    expect(withEngineSettings(withSettings, {})).toEqual({});
});

/* An address pool that dockerd would reject takes the engine down at start — from a field whose whole purpose
 * is fixing a network. Anything that isn't a CIDR is ignored instead, and a pool declared smaller than /24
 * carves at its own prefix rather than asking for the impossible. */
test("the address pool is parsed defensively — junk is ignored, small pools carve at their own prefix", () => {
    expect(addressPoolOf("10.201.0.0/16")).toEqual({ base: "10.201.0.0/16", size: 24 });
    expect(addressPoolOf("192.168.16.0/26")).toEqual({ base: "192.168.16.0/26", size: 26 });
    for (const junk of ["10.201.0.0", "not-a-cidr", "10.201.0.0/33", "999.1.1.1/16", "", undefined]) {
        expect(addressPoolOf(junk)).toBeUndefined();
    }
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
