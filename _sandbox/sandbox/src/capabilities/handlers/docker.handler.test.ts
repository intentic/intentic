import { expect, test } from "vitest";
import { packFragment, readPack } from "../../environment/packs.js";
import { registry } from "../registry.js";
import { addressPoolOf, isPrivileged, withEngineSettings } from "./docker.handler.js";

// Pins two contracts other code trusts: the fragment's directive (what rebuild executors allowlist, what the composed
// overlay records) and the CapEff probe deciding rebuild vs start now.

test("the fragment carries the privileged directive plus the engine pack when the base image lacks it", async () => {
    const fragment = (await registry.docker.fragment?.({})) ?? "";
    expect(fragment).toContain("# intentic:runtime --privileged");
    // Asserted against the pack's own content and the stamp, not against whatever image this happens to run on.
    expect((await readPack("docker"))!.content).toContain("docker-ce");
    const engine = await packFragment("docker");
    expect(fragment.includes("docker-ce")).toBe(engine !== undefined);
});

test("the gpu option adds the passthrough directive AND the toolkit the nested engine needs", async () => {
    const fragment = (await registry.docker.fragment?.({ gpu: "on" })) ?? "";
    expect(fragment).toContain("# intentic:runtime --privileged");
    expect(fragment).toContain("# intentic:runtime --gpus=all");
    expect(fragment).toContain("nvidia-container-toolkit");
    expect(fragment).toContain("nvidia-ctk runtime configure");
});

test("gpu off leaves no trace in the fragment", async () => {
    for (const config of [{}, { gpu: "off" }]) {
        expect((await registry.docker.fragment?.(config)) ?? "").not.toContain("--gpus");
    }
});

test("the echo carries every option, so the card opens on what the user actually set", () => {
    expect(registry.docker.echo({ gpu: "on", registryMirror: "https://mirror.example" }, new Map())).toEqual({
        gpu: true,
        registryMirror: "https://mirror.example",
        insecureRegistries: "",
        addressPool: "",
    });
    expect(registry.docker.echo({}, new Map())).toEqual({ gpu: false, registryMirror: "", insecureRegistries: "", addressPool: "" });
});

test("engine options never touch the fragment: only the image family costs a rebuild", async () => {
    const engine = { registryMirror: "https://mirror.example", insecureRegistries: "registry.lan:5000", addressPool: "10.201.0.0/16" };
    expect(await registry.docker.fragment?.(engine)).toBe(await registry.docker.fragment?.({}));
});

// Merge, never overwrite: the GPU option's `nvidia-ctk runtime configure` writes the nvidia runtime into this same file
// at build time.
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
    // Splits on commas and whitespace alike, not just one or the other.
    expect(merged["insecure-registries"]).toEqual(["registry.lan:5000", "other.lan:5000"]);
    expect(merged["default-address-pools"]).toEqual([{ base: "10.201.0.0/16", size: 24 }]);
});

test("clearing an engine option deletes its key rather than leaving the old value", () => {
    const withSettings = withEngineSettings({}, { registryMirror: "https://mirror.example", addressPool: "10.201.0.0/16" });
    expect(withEngineSettings(withSettings, {})).toEqual({});
});

test("the address pool is parsed defensively: junk is ignored, small pools carve at their own prefix", () => {
    expect(addressPoolOf("10.201.0.0/16")).toEqual({ base: "10.201.0.0/16", size: 24 });
    expect(addressPoolOf("192.168.16.0/26")).toEqual({ base: "192.168.16.0/26", size: 26 });
    for (const junk of ["10.201.0.0", "not-a-cidr", "10.201.0.0/33", "999.1.1.1/16", "", undefined]) {
        expect(addressPoolOf(junk)).toBeUndefined();
    }
});

test("docker cannot be removed: de-privileging a sandbox with live engine state is not a silent toggle", () => {
    expect(registry.docker.remove).toBeUndefined();
});

test("isPrivileged reads CAP_SYS_MODULE (bit 16) out of CapEff", () => {
    // Full effective set: a --privileged container.
    expect(isPrivileged("CapInh:\t0000000000000000\nCapEff:\t000001ffffffffff\n")).toBe(true);
    // The case this exists for: SYS_ADMIN/SYS_PTRACE on an unprivileged sandbox misread by a SYS_ADMIN-only probe.
    expect(isPrivileged("CapEff:\t00000000a82c25fb\n")).toBe(false);
    // Docker's default unprivileged cap set.
    expect(isPrivileged("CapEff:\t00000000a80425fb\n")).toBe(false);
    // vpn's NET_ADMIN grant on top of the sandbox set; still not privileged.
    expect(isPrivileged("CapEff:\t00000000a82c35fb\n")).toBe(false);
    // A plain user process, or an unreadable status.
    expect(isPrivileged("CapEff:\t0000000000000000\n")).toBe(false);
    expect(isPrivileged("")).toBe(false);
});
