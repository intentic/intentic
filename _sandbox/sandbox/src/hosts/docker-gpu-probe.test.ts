import { stubEnv, unstubAllEnvs } from "@intentic/testing/bun";
import type { Services } from "../composition.js";

// The host as the probe finds it: whether a device runs this sandbox, and what its agent answers.
const world = { host: undefined as string | undefined, answer: async (): Promise<{ text: string; refused: boolean }> => ({ text: "", refused: false }) };
jest.mock("./device-reports.js", () => ({
    devices: async () => [],
    callTool: async () => world.answer(),
    forgetPull: () => undefined,
    heldHostDevices: async () => [],
}));
jest.mock("./self-host.js", () => ({ hostRunningSelf: async () => world.host, ownSlug: () => undefined }));
const { gpuProbeAnswer, probeDockerGpu } = await import("./docker-gpu-probe.js");

const services = { hostHub: { state: () => ({ facts: { shell: "/bin/bash" } }) } } as unknown as Services;

beforeEach(() => {
    stubEnv("SANDBOX_VM", undefined);
    stubEnv("SANDBOX_IMAGE", "ghcr.io/intentic/sandbox:stable");
    world.host = "rog";
});
afterEach(unstubAllEnvs);

test("a real GPU listing accepts either NVIDIA runtime or CDI, without guessing from the runtime list", () => {
    expect(gpuProbeAnswer(false, "Exit code 0 (success).\n--- stdout ---\nGPU 0: NVIDIA (UUID: GPU-1234)").ok).toBe(true);
    expect(gpuProbeAnswer(false, "Exit code 125 (failed).\nfailed to discover GPU vendor from CDI: no known GPU vendor found")).toMatchObject({ checked: true, ok: false });
    expect(gpuProbeAnswer(false, "Exit code 0 (success).\nNo devices were found")).toMatchObject({ checked: true, ok: false });
});

// A GPU switch on a sandbox whose machine was not connected as a device could not be saved at all: "not asked" read as
// "no GPU", and the add route refuses a failed check. Only a device request that ran and failed is a refusal.
test("a check that could not run is unchecked, never a failed GPU", async () => {
    world.host = undefined;
    expect(await probeDockerGpu(services)).toMatchObject({ checked: false, ok: false });
    world.host = "rog";
    stubEnv("SANDBOX_IMAGE", undefined);
    expect(await probeDockerGpu(services)).toMatchObject({ checked: false, ok: false });
    stubEnv("SANDBOX_IMAGE", "ghcr.io/intentic/sandbox:stable");
    world.answer = async () => ({ text: "Run commands is off on this device.", refused: true });
    expect(await probeDockerGpu(services)).toMatchObject({ checked: false, ok: false });
    world.answer = async () => {
        throw new Error("device went away");
    };
    expect(await probeDockerGpu(services)).toMatchObject({ checked: false, ok: false });
});

test("a device request that ran answers for the host, and a hosted machine is refused outright", async () => {
    world.answer = async () => ({ text: "Exit code 0 (success).\n--- stdout ---\nGPU 0: NVIDIA (UUID: GPU-1234)", refused: false });
    expect(await probeDockerGpu(services)).toMatchObject({ checked: true, ok: true });
    world.answer = async () => ({ text: "Exit code 125 (failed).\n--- stderr ---\ncould not select device driver", refused: false });
    expect(await probeDockerGpu(services)).toMatchObject({ checked: true, ok: false });
    stubEnv("SANDBOX_VM", "1");
    expect(await probeDockerGpu(services)).toMatchObject({ checked: true, ok: false });
});
