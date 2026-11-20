import { WINDOW_GPU, WSL_GPU_LIBRARIES, windowGpu } from "./window-gpu.js";

// A `--gpus=all` sandbox on WSL2 with NVIDIA's driver, as its filesystem reads.
const WSL_NVIDIA = new Set([
    "/dev/dxg",
    `${WSL_GPU_LIBRARIES}/libd3d12.so`,
    `${WSL_GPU_LIBRARIES}/libdxcore.so`,
    `${WSL_GPU_LIBRARIES}/libcuda.so.1`,
    "/usr/lib/x86_64-linux-gnu/dri/d3d12_dri.so",
]);

const without = (path: string): ((candidate: string) => boolean) => (candidate) => candidate !== path && WSL_NVIDIA.has(candidate);

describe("a person's window on the GPU", () => {
    it("draws through Mesa's d3d12 driver on NVIDIA where WSL2 hands the sandbox its GPU", () => {
        expect(windowGpu((path) => WSL_NVIDIA.has(path), {})).toEqual({
            env: { LD_LIBRARY_PATH: "/usr/lib/wsl/lib", GALLIUM_DRIVER: "d3d12", MESA_D3D12_DEFAULT_ADAPTER_NAME: "NVIDIA" },
            args: ["--use-gl=angle", "--use-angle=gl", "--enable-gpu-rasterization"],
        });
    });

    it("stays in software without the device, Windows' libraries, NVIDIA's driver or Mesa's d3d12", () => {
        for (const missing of WSL_NVIDIA) {
            expect(windowGpu(without(missing), {})).toBeUndefined();
        }
    });

    it("stays in software when the daemon is told to", () => {
        expect(windowGpu((path) => WSL_NVIDIA.has(path), { INTENTIC_WINDOW_GPU: "0" })).toBeUndefined();
        expect(windowGpu((path) => WSL_NVIDIA.has(path), { INTENTIC_WINDOW_GPU: "1" })).toBe(WINDOW_GPU);
    });
});
