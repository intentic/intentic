import { CAPABILITY_CATALOG, capabilityFieldAvailable } from "@intentic/capability-catalog";
import { runtimeDirectivesOf, sandboxRunArgv, sandboxNames } from "@intentic/sandbox-run";
import { flyMachineConfig } from "@intentic/sandbox-run/fly";
import { registry } from "../registry.js";
import { optionStatuses } from "./docker.handler.js";

// Promoted from /tmp/repro/gpu: an unsupported ask must never keep selling a rebuild that cannot grant it.
const priorVm = process.env["SANDBOX_VM"];
const priorGpu = process.env["SANDBOX_GPU"];
afterEach(() => {
    if (priorVm === undefined) {
        delete process.env["SANDBOX_VM"];
    } else {
        process.env["SANDBOX_VM"] = priorVm;
    }
    if (priorGpu === undefined) {
        delete process.env["SANDBOX_GPU"];
    } else {
        process.env["SANDBOX_GPU"] = priorGpu;
    }
});

test("the catalogue gates the GPU switch to local and self-hosted sandboxes", () => {
    const docker = CAPABILITY_CATALOG.find((entry) => entry.id === "docker")!;
    expect(capabilityFieldAvailable(docker, "gpu", true)).toBe(false);
    expect(capabilityFieldAvailable(docker, "gpu", false)).toBe(true);
    expect(capabilityFieldAvailable(docker, "registryMirror", true)).toBe(true);
});

test("local GPU asks still compose the device request; hosted asks compose no unusable GPU build", async () => {
    delete process.env["SANDBOX_VM"];
    expect(runtimeDirectivesOf(String(await registry.docker.fragment?.({ gpu: "on" })))).toEqual(["--privileged", "--gpus=all"]);
    process.env["SANDBOX_VM"] = "1";
    const fragment = String(await registry.docker.fragment?.({ gpu: "on" }));
    expect(runtimeDirectivesOf(fragment)).toEqual(["--privileged"]);
    expect(fragment).not.toContain("nvidia-container-toolkit");
});

test("Fly stamps GPU as unsupported", () => {
    const config = flyMachineConfig({
        name: "app",
        image: "img",
        baseImage: "img",
        guest: { cpuKind: "shared", cpus: 2, memoryMb: 4096 },
        volumeId: "vol",
    });
    expect(config.env["SANDBOX_GPU"]).toBe("unsupported");
});

test("even an older hosted machine without a GPU stamp reports unsupported, never rebuild required", async () => {
    process.env["SANDBOX_VM"] = "1";
    delete process.env["SANDBOX_GPU"];
    expect(await optionStatuses({ gpu: "on" })).toEqual([{ state: "error", detail: "GPU access: unsupported on hosted sandboxes" }]);
    expect(await optionStatuses({ gpu: "off" })).toEqual([]);
});

test("a host that cannot grant GPU access drops the flag and stamps its refusal", () => {
    const base = { names: sandboxNames("repro"), image: "img", baseImage: "img", runtime: ["--privileged", "--gpus=all"] };
    expect(sandboxRunArgv(base)).toContain("--gpus=all");
    const dropped = sandboxRunArgv({ ...base, unsupported: ["--gpus=all"] });
    expect(dropped).not.toContain("--gpus=all");
    expect(dropped).toContain("SANDBOX_GPU=unsupported");
});
// The original idle-stop assertion already lives in system/idle-stop.test.ts: sleeping is expected behaviour.
