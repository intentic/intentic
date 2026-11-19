import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { GpuSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { GPU_RUN_BIN, gpuShellPrefix, writeGpuState } from "./gpu-state.js";

// bin/gpu-run as the image installs it, run against a stand-in for the GPU: a file where its device node would be and a
// folder where WSL mounts the driver libraries. Nothing here touches a real GPU.
const GPU_RUN = join(packageRoot(import.meta.url), "bin/gpu-run");
const gpu = GpuSettingsSchema.parse({});

// Vulkan driver manifests, by file name, in the folder the loader reads them from (none: an image without Mesa's Vulkan).
const machine = (withGpu: boolean, manifests: readonly string[] = []) => {
    const root = mkdtempSync(join(tmpdir(), "gpu-run-"));
    const libs = join(root, "wsl-lib");
    mkdirSync(libs);
    const icds = join(root, "icd.d");
    mkdirSync(icds);
    for (const manifest of manifests) {
        writeFileSync(join(icds, manifest), "{}");
    }
    const dxg = join(root, "dxg");
    if (withGpu) {
        writeFileSync(dxg, "");
    }
    const state = join(root, "gpu-state");
    const run = (args: readonly string[], env: Record<string, string> = {}) => {
        const result = spawnSync("bash", [GPU_RUN, ...args], {
            encoding: "utf8",
            env: {
                PATH: process.env["PATH"] ?? "",
                INTENTIC_GPU_DEVICES: dxg,
                INTENTIC_GPU_LIBRARY_PATH: libs,
                INTENTIC_GPU_STATE: state,
                INTENTIC_VULKAN_ICD_DIRS: icds,
                ...env,
            },
        });
        return { code: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    const settle = (over: Partial<typeof gpu>): void => writeGpuState({ ...gpu, ...over }, (message) => expect(message).toBe(""), state);
    return { run, settle, libs, icds };
};

const printLibraryPath = ["sh", "-c", 'printf "%s|%s" "${LD_LIBRARY_PATH:-}" "${INTENTIC_GPU_RUN:-}"'];

test("a command run through gpu-run gets the WSL GPU libraries first on its library path, and nothing else does", () => {
    const { run, libs } = machine(true);
    expect(run(printLibraryPath, { LD_LIBRARY_PATH: "/opt/own" })).toEqual({ code: 0, stdout: `${libs}:/opt/own|1`, stderr: "" });
    expect(run(printLibraryPath).stdout).toBe(`${libs}|1`);
});

test("without the GPU it says so, and how to ask for it", () => {
    const { run } = machine(false);
    const answer = run(["true"]);
    expect(answer.code).toBe(69);
    expect(answer.stderr).toContain("this sandbox has no GPU");
    expect(answer.stderr).toContain("capabilities request docker --set gpu=on");
    expect(run(["--status"]).stdout.split("\n")[0]).toBe("no GPU in this sandbox");
});

test("while GPU work is paused after a GPU reset it refuses, naming the event", () => {
    const { run, settle } = machine(true);
    settle({ pausedFor: "rog reported a GPU reset at 2026-11-02T19:30:49Z (LiveKernelEvent 141)." });
    const answer = run(["true"]);
    expect(answer.code).toBe(75);
    expect(answer.stderr).toContain("GPU work is paused: rog reported a GPU reset at 2026-11-02T19:30:49Z (LiveKernelEvent 141).");
    expect(run(["--status"]).stdout).toContain("paused: rog reported a GPU reset");
});

test("a browser flag that overrides the GPU safety list is refused", () => {
    const { run } = machine(true);
    const answer = run(["chromium", "--headless", "--ignore-gpu-blocklist"]);
    expect(answer.code).toBe(64);
    expect(answer.stderr).toContain("refusing --ignore-gpu-blocklist");
});

test("no wall limit by default; --timeout and the setting each stop a command that runs past theirs", () => {
    const { run, settle } = machine(true);
    expect(run(["sh", "-c", "sleep 0.2; echo done"]).stdout).toBe("done\n");
    expect(run(["--timeout", "1s", "sleep", "5"]).code).toBe(124);
    expect(run(["--timeout", "soon", "true"]).code).toBe(2);
    settle({ timeoutMinutes: 1 });
    expect(run(["--status"]).stdout).toContain("wall limit: 1m");
});

// settings gpu.shells = "all": the daemon puts gpu-run --if-available in front of every agent command.
test("--if-available runs the command either way, with the GPU only while it may be had", () => {
    const { run, settle, libs } = machine(true);
    expect(run(["--if-available", "--", ...printLibraryPath]).stdout).toBe(`${libs}|1`);
    settle({ pausedFor: "a GPU reset" });
    expect(run(["--if-available", "--", ...printLibraryPath])).toEqual({ code: 0, stdout: "|", stderr: "" });
    expect(machine(false).run(["--if-available", "--", ...printLibraryPath])).toEqual({ code: 0, stdout: "|", stderr: "" });
});

test("the daemon puts gpu-run in front of every agent command only in `all` mode on a sandbox with a GPU", () => {
    const { settle } = machine(true);
    settle({ shells: "all" });
    expect(gpuShellPrefix(() => true)).toBe(`${GPU_RUN_BIN} --if-available -- `);
    expect(gpuShellPrefix(() => false)).toBe("");
    settle({ shells: "on-request" });
    expect(gpuShellPrefix(() => true)).toBe("");
});

// The entrypoint evaluates `gpu-run --software-env` for the whole container (docker-entrypoint.sh): the variables as
// they reach a process outside gpu-run, then inside it.
const printRendering = ["sh", "-c", 'printf "%s|%s|%s|%s" "${LIBGL_ALWAYS_SOFTWARE:-}" "${GALLIUM_DRIVER:-}" "${VK_DRIVER_FILES:-}" "${VK_ICD_FILENAMES:-}"'];

const exportsOf = (text: string): Record<string, string> =>
    Object.fromEntries([...text.matchAll(/^export (\w+)='([^']*)'$/gmu)].map((match) => [match[1] ?? "", match[2] ?? ""]));

// shinobi-society, 2026-11-15..17: scripts/soft.sh (LD_LIBRARY_PATH unset, Vulkan on lavapipe, OpenGL on llvmpipe)
// wrapped 316 commands, and gpu-run with the project's own GPU switch still rendered on llvmpipe.
test("every other command is pinned to software rendering, and gpu-run takes back only what the sandbox pinned", () => {
    const { run, settle, icds } = machine(true, ["lvp_icd.x86_64.json", "dzn_icd.x86_64.json"]);
    const lavapipe = join(icds, "lvp_icd.x86_64.json");
    const pins = exportsOf(run(["--software-env"]).stdout);
    expect(pins).toEqual({
        LIBGL_ALWAYS_SOFTWARE: "1",
        GALLIUM_DRIVER: "llvmpipe",
        VK_DRIVER_FILES: lavapipe,
        VK_ICD_FILENAMES: lavapipe,
        INTENTIC_SOFTWARE_RENDERING: "LIBGL_ALWAYS_SOFTWARE GALLIUM_DRIVER VK_DRIVER_FILES VK_ICD_FILENAMES",
    });
    // Through gpu-run every pin is gone, so Mesa's d3d12 and the Dozen driver can load.
    expect(run(printRendering, pins).stdout).toBe("|||");
    // A pin someone changed since is theirs, and stays.
    expect(run(printRendering, { ...pins, VK_DRIVER_FILES: "/own/icd.json" }).stdout).toBe("||/own/icd.json|");
    // With the GPU paused, --if-available runs the command as it is: pinned.
    settle({ pausedFor: "a GPU reset" });
    expect(run(["--if-available", "--", ...printRendering], pins).stdout).toBe(`1|llvmpipe|${lavapipe}|${lavapipe}`);
});

test("a value the image or the project already sets is left out of the pins, and with no lavapipe Vulkan is left unpinned", () => {
    const { run } = machine(false);
    expect(exportsOf(run(["--software-env"], { GALLIUM_DRIVER: "softpipe" }).stdout)).toEqual({
        LIBGL_ALWAYS_SOFTWARE: "1",
        INTENTIC_SOFTWARE_RENDERING: "LIBGL_ALWAYS_SOFTWARE",
    });
});

test("--status says what renders where, and that without a Dozen driver Vulkan stays on the CPU even through gpu-run", () => {
    const status = machine(true, ["lvp_icd.x86_64.json"]).run(["--status"]).stdout;
    expect(status).toContain("outside gpu-run, rendering is on the CPU: OpenGL on llvmpipe, Vulkan on lavapipe");
    expect(status).toContain("Vulkan still on lavapipe: the image has no Vulkan driver for this GPU (Mesa's Dozen");
    expect(status).toContain("gpu-run --on <device> -- <command>");
    expect(machine(true, ["lvp_icd.x86_64.json", "dzn_icd.x86_64.json"]).run(["--status"]).stdout).toContain(
        "Vulkan on Mesa's Dozen (dzn_icd.x86_64.json), D3D12 underneath",
    );
    expect(machine(false).run(["--status"]).stdout).toContain("Vulkan unpinned, since the image has no lavapipe");
});

test("--on hands the run to `devices exec`, and is refused while GPU work is paused", () => {
    const { run, settle } = machine(false);
    const help = run(["--on", "rog", "--help"]);
    expect([help.code, help.stdout]).toEqual([0, expect.stringContaining("devices exec <device>")]);
    settle({ pausedFor: "rog reported a GPU reset" });
    const paused = run(["--on", "rog", "--", "cargo", "run"]);
    expect(paused.code).toBe(75);
    expect(paused.stderr).toContain("devices exec rog -- <command>");
});
