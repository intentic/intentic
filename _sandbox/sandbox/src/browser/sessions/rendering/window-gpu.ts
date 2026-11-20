import { existsSync } from "node:fs";

// A window a person opened (their own browser, a profile's sign-in window) renders on the host's GPU where the sandbox
// has one it can draw with, and in software everywhere else. Agents' browsers never do (software-rendering.ts): the GPU
// is the owner's, and the window the owner is looking at is theirs to spend it on.
//
// Measured 2026-11-20 on rog (RTX 5080 Laptop, WSL2) in a container of the sandbox image started with `--gpus all`, a
// page scrolled at 60 fps and watched through castd: Chromium took 0.15 cores at 1280x880 and 0.22 at 2560x1600 on the
// GPU, against 1.61 and 2.32 in software, which at 2560x1600 managed only 51 fps. castd's own share was the same either
// way. The castd README has the rest (WebGL, a page of blurred cards).
//
// Only WSL2's GPU, and only NVIDIA's: Mesa's d3d12 driver renders through Windows' Direct3D 12 there, the one GPU path a
// container on these machines has (the README says why VA-API and Vulkan are not), and on the Intel iGPU WebGL frames
// never reached the X screen, so the adapter is named. A native Linux host's GPU is not used: nothing measured it.

// Windows' user-mode Direct3D 12 and DXCore, and NVIDIA's driver beside them, as `--gpus=all` mounts them on WSL2.
export const WSL_GPU_LIBRARIES = "/usr/lib/wsl/lib";

// Mesa's Gallium driver for Direct3D 12, by the multiarch directories Debian installs it in.
const MESA_D3D12_DRIVERS = ["/usr/lib/x86_64-linux-gnu/dri/d3d12_dri.so", "/usr/lib/aarch64-linux-gnu/dri/d3d12_dri.so"];

// What a window needs to draw on the GPU: the variables that point Mesa at the d3d12 driver and Windows' libraries, and
// the switches that put Chromium's compositing and rasterizing on GL through ANGLE (what a Linux desktop runs anyway).
export interface WindowGpu {
    readonly env: Readonly<Record<string, string>>;
    readonly args: readonly string[];
}

export const WINDOW_GPU: WindowGpu = {
    env: { LD_LIBRARY_PATH: WSL_GPU_LIBRARIES, GALLIUM_DRIVER: "d3d12", MESA_D3D12_DEFAULT_ADAPTER_NAME: "NVIDIA" },
    args: ["--use-gl=angle", "--use-angle=gl", "--enable-gpu-rasterization"],
};

// Set to 0 in the daemon's environment to keep every window in software.
const WINDOW_GPU_ENV = "INTENTIC_WINDOW_GPU";

// The GPU a person's window draws with here, or undefined to stay in software: WSL2's paravirtual GPU device, Windows'
// libraries and NVIDIA's mounted into the sandbox, and Mesa's d3d12 driver in the image.
export const windowGpu = (exists: (path: string) => boolean = existsSync, env: NodeJS.ProcessEnv = process.env): WindowGpu | undefined => {
    if (env[WINDOW_GPU_ENV] === "0") {
        return undefined;
    }
    const present =
        exists("/dev/dxg") &&
        ["libd3d12.so", "libdxcore.so", "libcuda.so.1"].every((library) => exists(`${WSL_GPU_LIBRARIES}/${library}`)) &&
        MESA_D3D12_DRIVERS.some(exists);
    return present ? WINDOW_GPU : undefined;
};
