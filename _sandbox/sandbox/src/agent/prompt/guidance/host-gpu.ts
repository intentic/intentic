import { existsSync } from "node:fs";
import { GPU_LIBRARY_ENV, gpuHere, WSL_GPU_LIBRARY_PATH } from "../../../hosts/gpu/gpu-state.js";

/* THE HOST GPU, AS A TURN IS TOLD OF IT (2026-11-03). With the GPU switch on, a sandbox on a Windows PC shares the
   owner's display GPU through WSL. Agents did not know: 65 conversations on rog rendered on it unasked, and one launched
   Chromium with `--ignore-gpu-blocklist` against Mesa's d3d12 driver, hung the GPU (LiveKernelEvent 0x141) and powered
   the PC off. Said only where the GPU is here, since on any other sandbox it is a paragraph about nothing. */

// The WSL kind: the device node with the driver's libraries mounted beside it (gpu-state.ts gpuHere says why both).
const wslGpu = (exists: (path: string) => boolean): boolean => exists("/dev/dxg") && exists(process.env[GPU_LIBRARY_ENV] ?? WSL_GPU_LIBRARY_PATH);

export const hostGpu = (exists: (path: string) => boolean = existsSync): boolean => gpuHere(exists);

export const hostGpuGuidance = (exists: (path: string) => boolean = existsSync): string =>
    `${wslGpu(exists)
        ? "This sandbox has the GPU of the computer it runs on, and that is the owner's DISPLAY GPU, shared with their Windows through WSL (`/dev/dxg`): a GPU hang or a driver reset freezes or powers off their whole computer, not just this sandbox. "
        : "This sandbox has the NVIDIA GPU of the computer it runs on. " 
    }Nothing here uses it unless asked: run GPU work through \`gpu-run <command…>\` (a native game build, a wgpu or Vulkan program, CUDA), which gives that one command the whole GPU with no limit unless you pass \`--timeout\`; \`gpu-run --status\` says whether it is available, and every other command, browsers included, runs on the CPU. ` +
    `When gpu-run says GPU work is paused, the computer reported a GPU reset: do not route around it (no library paths set by hand), carry on without the GPU and tell the owner, who resumes it from the sandbox's Overview. ` +
    `Never start a browser with flags that override its GPU safety list (\`--ignore-gpu-blocklist\`, \`--enable-unsafe-webgpu\`, \`--use-angle=gl\` with a GPU driver forced) or pin Mesa to the GPU (\`GALLIUM_DRIVER=d3d12\`); gpu-run refuses them. A web page that needs real GPU rendering (WebGPU, WebGL frame rates) belongs in the owner's own browser on their device, through its browser tools, not in a browser here.`;
