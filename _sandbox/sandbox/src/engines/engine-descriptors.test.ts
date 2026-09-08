import { ENGINE_IDS } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { ENGINE_DESCRIPTORS, engineDescriptor, releaseArch } from "./engine-descriptors.js";

// Guards the descriptor table by discovery, not a second list: every contract engine must have a descriptor, and each
// floor must be the version the image actually carries.

test("every engine the contract names has a descriptor, and no descriptor names an engine it does not", () => {
    expect(ENGINE_DESCRIPTORS.map((descriptor) => descriptor.id).toSorted()).toEqual([...ENGINE_IDS].toSorted());
});

// Floor is read from the pack the image builds with (or Claude's own dependency); a pack that does not name exactly one
// version reads as no floor (undefined).
test("each engine's floor is the version this build actually pins", async () => {
    for (const descriptor of ENGINE_DESCRIPTORS) {
        expect(await descriptor.baked(), `${descriptor.id} floor`).toMatch(/^\d+\.\d+\.\d+/);
    }
});

// npm publishes Claude as 0.3.N while the CLI calls itself 2.1.N; the API states floors in the second, so a plain
// version comparison never satisfies them.
test("a Claude floor in CLI numbers is read by the component the two share", () => {
    const claude = engineDescriptor("claude");
    expect(claude.satisfiesFloor?.("0.3.257", "2.1.251")).toBe(true);
    expect(claude.satisfiesFloor?.("0.3.233", "2.1.251")).toBe(false);
    expect(claude.satisfiesFloor?.("0.3.251", "2.1.251")).toBe(true);
});

test("a Claude floor in the package's own numbers compares as versions", () => {
    const claude = engineDescriptor("claude");
    expect(claude.satisfiesFloor?.("0.3.257", "0.3.251")).toBe(true);
    expect(claude.satisfiesFloor?.("0.3.251", "0.3.251")).toBe(true);
    expect(claude.satisfiesFloor?.("0.3.240", "0.3.251")).toBe(false);
});

// CLIProxyAPI publishes `linux_amd64` and `linux_aarch64`; the kernel's `x86_64` names no file it ever released. Both
// tokens are pinned since CI and an arm laptop each exercise only one branch.
test("the translator asks for the architecture word upstream publishes, not the kernel's", () => {
    expect(releaseArch("x64")).toBe("amd64");
    expect(releaseArch("arm64")).toBe("aarch64");
});

// Rest of the asset name is pinned to the release's own list (prefix, `linux_` platform word, extension); only the
// version and the architecture word (above) vary.
test("the translator's asset is the file its release carries", () => {
    const { source } = engineDescriptor("translator");
    const asset = source.kind === "github-release" ? source.asset("7.2.140") : undefined;
    expect(asset).toBe(`CLIProxyAPI_7.2.140_linux_${releaseArch()}.tar.gz`);
});

// Only the in-process engine has two vocabularies to reconcile, so it alone is excluded here.
test("the spawned engines report the version they are published under", () => {
    for (const descriptor of ENGINE_DESCRIPTORS.filter((candidate) => candidate.id !== "claude")) {
        expect(descriptor.satisfiesFloor, `${descriptor.id}`).toBeUndefined();
        expect(descriptor.reportedVersion, `${descriptor.id}`).toBeUndefined();
    }
});
