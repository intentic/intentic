import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Every Chromium this daemon starts renders in software, on purpose and said so, never on a GPU by accident.
//
// The sandbox can run with the host's GPU passed in (`--gpus=all` on a WSL2 machine), and its environment then carries
// LD_LIBRARY_PATH=/usr/lib/wsl/lib and friends. A browser launched with `{ ...process.env }` inherited that, so it was
// on SwiftShader only because nothing it probed happened to work, and a later image or driver could have changed
// that under every agent. The host GPU is the owner's, shared with whatever they are running, and a browser driven by an
// agent must not take it. So the GPU-selecting environment is dropped and the backends are named outright: ANGLE on
// SwiftShader for WebGL, and Chromium's own SwiftShader Vulkan ICD as the only Vulkan driver its loader may open.
// (2026-11-03: shinobi-society audit; the alternative, leaving Chromium to pick, is what made it accidental.)

// Variables that point a GL, EGL or Vulkan loader at a driver, or a dynamic linker at the host's GPU libraries.
const GPU_ENV_EXACT = new Set(["LD_LIBRARY_PATH", "GALLIUM_DRIVER", "DRI_PRIME", "EGL_PLATFORM", "CUDA_VISIBLE_DEVICES"]);
const GPU_ENV_PREFIXES = ["MESA_", "LIBGL_", "__EGL_", "__GLX_", "__NV_", "VK_", "NVIDIA_", "DXG_"];

export const isGpuSelectingEnv = (key: string): boolean => GPU_ENV_EXACT.has(key) || GPU_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));

// ANGLE on SwiftShader for WebGL. `--enable-unsafe-swiftshader` keeps WebGL on it at all: recent Chromium no longer
// falls back to a software WebGL context unless asked (Playwright passes the same switch for the windows it launches).
// The agents' browsers only: the owner's sign-in window keeps a plain desktop start's flags (owner-browser.ts) and gets
// the environment alone.
export const SOFTWARE_GL_ARGS: readonly string[] = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

// WebGPU on SwiftShader through Dawn: navigator.gpu.requestAdapter() answers a fallback adapter (vendor "google",
// architecture "swiftshader") instead of null, so a game's WebGPU path can be exercised at all. Measured 2026-11-03 on
// Chromium 1248 in a sandbox with no GPU, headed on Xvfb and headless alike; without these flags the adapter is null
// ("No available adapters"). The credential-free browser only (browser-tools.ts says why).
export const SOFTWARE_WEBGPU_ARGS: readonly string[] = ["--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader"];

// The SwiftShader Vulkan driver Chromium ships beside its binary, when this build has one.
const swiftshaderIcd = (executablePath: string): string | undefined => {
    const icd = join(dirname(executablePath), "vk_swiftshader_icd.json");
    return existsSync(icd) ? icd : undefined;
};

// `env` without anything that selects a GPU, and with Vulkan's driver list pinned to SwiftShader's ICD when the build
// ships one: the loader then opens that driver and no other, whatever ICDs the image has installed.
export const softwareRenderingEnv = (env: NodeJS.ProcessEnv, executablePath: string): Record<string, string> => {
    const kept = Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !isGpuSelectingEnv(entry[0])),
    );
    const icd = swiftshaderIcd(executablePath);
    return icd === undefined ? kept : { ...kept, VK_ICD_FILENAMES: icd, VK_DRIVER_FILES: icd };
};
