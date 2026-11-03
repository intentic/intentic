import { GpuSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { GPU_LIBRARY_ENV, forgetGpuLibraryPath, gpuStateText, withoutGpuLibraries } from "./gpu-state.js";

const gpu = GpuSettingsSchema.parse({});

// An engine before 2026-11-03 set the WSL libraries as the whole container's library path.
test("the WSL GPU libraries come off the library path and their place is kept for gpu-run", () => {
    const env: NodeJS.ProcessEnv = { LD_LIBRARY_PATH: "/usr/lib/wsl/lib" };
    expect(forgetGpuLibraryPath(env)).toBe(true);
    expect(env).toEqual({ [GPU_LIBRARY_ENV]: "/usr/lib/wsl/lib" });

    const mixed: NodeJS.ProcessEnv = { LD_LIBRARY_PATH: "/opt/a:/usr/lib/wsl/lib/:/opt/b", [GPU_LIBRARY_ENV]: "/elsewhere" };
    expect(forgetGpuLibraryPath(mixed)).toBe(true);
    expect(mixed).toEqual({ LD_LIBRARY_PATH: "/opt/a:/opt/b", [GPU_LIBRARY_ENV]: "/elsewhere" });

    const plain: NodeJS.ProcessEnv = { LD_LIBRARY_PATH: "/opt/a" };
    expect(forgetGpuLibraryPath(plain)).toBe(false);
    expect(plain).toEqual({ LD_LIBRARY_PATH: "/opt/a" });
    expect(withoutGpuLibraries(undefined)).toBeUndefined();
});

test("the state file says the shells mode, the wall limit and the pause on one line each", () => {
    expect(gpuStateText(gpu)).toBe("shells=on-request\ntimeout_minutes=0\npaused=\n");
    expect(gpuStateText({ shells: "all", timeoutMinutes: 30, pausedFor: "rog reported a GPU reset\nat 19:30" })).toBe(
        "shells=all\ntimeout_minutes=30\npaused=rog reported a GPU reset at 19:30\n",
    );
});
