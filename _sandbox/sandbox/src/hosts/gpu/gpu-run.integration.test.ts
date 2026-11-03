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

const machine = (withGpu: boolean) => {
    const root = mkdtempSync(join(tmpdir(), "gpu-run-"));
    const libs = join(root, "wsl-lib");
    mkdirSync(libs);
    const dxg = join(root, "dxg");
    if (withGpu) {
        writeFileSync(dxg, "");
    }
    const state = join(root, "gpu-state");
    const run = (args: readonly string[], env: Record<string, string> = {}) => {
        const result = spawnSync("bash", [GPU_RUN, ...args], {
            encoding: "utf8",
            env: { PATH: process.env["PATH"] ?? "", INTENTIC_GPU_DEVICES: dxg, INTENTIC_GPU_LIBRARY_PATH: libs, INTENTIC_GPU_STATE: state, ...env },
        });
        return { code: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    const settle = (over: Partial<typeof gpu>): void => writeGpuState({ ...gpu, ...over }, (message) => expect(message).toBe(""), state);
    return { run, settle, libs };
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
    expect(run(["--status"]).stdout).toBe("no GPU in this sandbox\n");
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
