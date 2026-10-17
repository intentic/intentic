import { gpuProbeAnswer } from "./docker-gpu-probe.js";

test("a real GPU listing accepts either NVIDIA runtime or CDI, without guessing from the runtime list", () => {
    expect(gpuProbeAnswer(false, "Exit code 0 (success).\n--- stdout ---\nGPU 0: NVIDIA (UUID: GPU-1234)").ok).toBe(true);
    expect(gpuProbeAnswer(true, "Exit code 0 (success).\nGPU 0: NVIDIA (UUID: GPU-1234)").ok).toBe(false);
    expect(gpuProbeAnswer(false, "Exit code 125 (failed).\nfailed to discover GPU vendor from CDI: no known GPU vendor found").ok).toBe(false);
    expect(gpuProbeAnswer(false, "Exit code 0 (success).\nNo devices were found").ok).toBe(false);
});
