import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGpuSelectingEnv, softwareRenderingEnv } from "./software-rendering.js";

// A `--gpus=all` WSL sandbox hands every process the host's GPU libraries; no browser here may inherit them.
const GPU_SANDBOX_ENV = {
    PATH: "/usr/bin",
    HOME: "/root",
    DISPLAY: ":99",
    LD_LIBRARY_PATH: "/usr/lib/wsl/lib",
    GALLIUM_DRIVER: "d3d12",
    MESA_D3D12_DEFAULT_ADAPTER_NAME: "NVIDIA",
    LIBGL_ALWAYS_SOFTWARE: "0",
    __EGL_VENDOR_LIBRARY_FILENAMES: "/usr/share/glvnd/egl_vendor.d/10_nvidia.json",
    __GLX_VENDOR_LIBRARY_NAME: "nvidia",
    VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/dzn_icd.x86_64.json",
    NVIDIA_VISIBLE_DEVICES: "all",
};

describe("software rendering environment", () => {
    it("drops everything that selects a GPU and keeps the rest", () => {
        const env = softwareRenderingEnv(GPU_SANDBOX_ENV, "/nowhere/chrome");
        expect(env).toEqual({ PATH: "/usr/bin", HOME: "/root", DISPLAY: ":99" });
        expect(isGpuSelectingEnv("LD_PRELOAD")).toBe(false);
    });

    it("pins Vulkan to the SwiftShader driver shipped beside the binary", () => {
        const dir = mkdtempSync(join(tmpdir(), "swiftshader-"));
        writeFileSync(join(dir, "vk_swiftshader_icd.json"), "{}");
        const env = softwareRenderingEnv(GPU_SANDBOX_ENV, join(dir, "chrome"));
        expect(env["VK_ICD_FILENAMES"]).toBe(join(dir, "vk_swiftshader_icd.json"));
        expect(env["VK_DRIVER_FILES"]).toBe(join(dir, "vk_swiftshader_icd.json"));
        expect(env["LD_LIBRARY_PATH"]).toBeUndefined();
    });
});
