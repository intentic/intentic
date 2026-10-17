import { gpuProbeArgv, gpuProbePassed } from "./index.js";

test("the host probe exercises --gpus and requires an actual device, without pulling an image", () => {
    expect(gpuProbeArgv("already-local")).toEqual([
        "docker",
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--gpus=all",
        "--entrypoint=nvidia-smi",
        "already-local",
        "-L",
    ]);
    expect(gpuProbePassed(0, "GPU 0: NVIDIA (UUID: GPU-abcd)")).toBe(true);
    expect(gpuProbePassed(125, "failed to discover GPU vendor from CDI: no known GPU vendor found")).toBe(false);
    expect(gpuProbePassed(0, '{"nvidia": {}}')).toBe(false);
    expect(gpuProbePassed(0, "No devices were found")).toBe(false);
    expect(gpuProbePassed(1, "GPU 0: NVIDIA (UUID: GPU-abcd)")).toBe(false);
});
