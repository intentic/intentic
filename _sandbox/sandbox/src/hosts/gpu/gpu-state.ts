import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { writeFileAtomicSync } from "@intentic/base/fs";
import type { GpuSettings, SandboxSettings } from "@intentic/sandbox-contract/schemas/settings";

/* THE HOST GPU, ON REQUEST (2026-11-03). On a Windows PC a GPU sandbox's GPU is the owner's display GPU, shared through
   WSL: /dev/dxg, and the driver's user-mode libraries in /usr/lib/wsl/lib. The engine used to put those libraries on the
   whole container's LD_LIBRARY_PATH, so every process here rendered on that GPU unasked (65 conversations on rog), and
   one hang powered the PC off. Now the engine leaves the path alone (ic engine/rootfs/intentic-engine), this daemon
   takes them off its own environment for anything older (forgetGpuLibraryPath), and a command gets the GPU through
   `gpu-run` (bin/gpu-run), or every agent command does where the owner chose `gpu.shells: "all"`.

   gpu-run is a shell script, so what it must know from the daemon (GPU work paused after a GPU reset, the wall limit,
   the shells mode) is a small `key=value` file this module writes at boot and on every settings write. */

// Where the WSL GPU driver libraries are mounted (the engine's CDI spec, and Docker Desktop's).
export const WSL_GPU_LIBRARY_PATH = "/usr/lib/wsl/lib";
// The variable the engine's spec names that place by, and the entrypoint keeps it in when it takes the path away.
export const GPU_LIBRARY_ENV = "INTENTIC_GPU_LIBRARY_PATH";
export const GPU_RUN_BIN = "/usr/local/bin/gpu-run";
// Read per call, so a test can point it elsewhere; gpu-run reads the same variable.
export const gpuStateFile = (): string => process.env["INTENTIC_GPU_STATE"] ?? "/run/intentic/gpu-state";

const isWslGpuLibraries = (entry: string): boolean => entry.replace(/\/+$/u, "") === WSL_GPU_LIBRARY_PATH;

/** LD_LIBRARY_PATH without the WSL GPU libraries: undefined when nothing else was on it. */
export const withoutGpuLibraries = (value: string | undefined): string | undefined => {
    const kept = (value ?? "").split(":").filter((entry) => entry !== "" && !isWslGpuLibraries(entry));
    return kept.length === 0 ? undefined : kept.join(":");
};

/**
 * Takes the WSL GPU libraries off this process's library path before anything is spawned, keeping where they were for
 * gpu-run (GPU_LIBRARY_ENV). The image's entrypoint already did it for the whole container; this covers a start that
 * skips it (a compose file with its own entrypoint, a dev run). Answers whether it took anything.
 */
export const forgetGpuLibraryPath = (env: NodeJS.ProcessEnv = process.env): boolean => {
    const current = env["LD_LIBRARY_PATH"];
    if (current === undefined || !current.split(":").some(isWslGpuLibraries)) {
        return false;
    }
    env[GPU_LIBRARY_ENV] ??= WSL_GPU_LIBRARY_PATH;
    const kept = withoutGpuLibraries(current);
    if (kept === undefined) {
        delete env["LD_LIBRARY_PATH"];
    } else {
        env["LD_LIBRARY_PATH"] = kept;
    }
    return true;
};

/** Whether this sandbox has a GPU a command could use: the GPU switch's flag rode, or the device and its libraries are here. */
export const gpuHere = (exists: (path: string) => boolean = existsSync): boolean =>
    process.env["SANDBOX_GPU"] === "all" ||
    exists("/dev/nvidiactl") ||
    (exists("/dev/dxg") && exists(process.env[GPU_LIBRARY_ENV] ?? WSL_GPU_LIBRARY_PATH));

// One line per key; a value never carries a line break, so gpu-run's `read` takes each whole.
const flat = (text: string): string => text.replaceAll(/[\r\n]+/gu, " ").trim();

/** The state file's text, from the settings' `gpu` part. */
export const gpuStateText = (gpu: GpuSettings): string =>
    [`shells=${gpu.shells}`, `timeout_minutes=${String(gpu.timeoutMinutes)}`, `paused=${flat(gpu.pausedFor ?? "")}`, ""].join("\n");

// The shells mode as last read, for the prefix every agent command is built with (agent-terminals.ts), which is built
// synchronously and per command.
let shellsAll = false;

/**
 * What goes in front of an agent's command so that it gets the GPU: nothing, unless the owner chose `gpu.shells: "all"`
 * and this sandbox has a GPU. gpu-run's `--if-available` runs the command either way, without the GPU while GPU work is
 * paused, and applies no wall limit: an agent's command has its own.
 */
export const gpuShellPrefix = (here: () => boolean = gpuHere): string => (shellsAll && here() ? `${GPU_RUN_BIN} --if-available -- ` : "");

/** Writes the state file whole (a reader never sees half of one) and remembers the shells mode. Never throws. */
export const writeGpuState = (gpu: GpuSettings, warn: (message: string) => void, path: string = gpuStateFile()): void => {
    shellsAll = gpu.shells === "all";
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileAtomicSync(path, gpuStateText(gpu), 0o644);
    } catch (error) {
        warn(`gpu: the state gpu-run reads could not be written, so it runs as if nothing were paused: ${errorMessage(error)}`);
    }
};

export interface GpuSettingsSource {
    readonly get: () => Promise<SandboxSettings>;
    readonly onSet: (listener: () => void) => () => void;
}

/** Keeps the state file in step with the settings from now on: written once now, and again after every settings write. */
export const keepGpuState = (settings: GpuSettingsSource, warn: (message: string) => void): (() => void) => {
    const write = (): void => {
        void settings.get().then(
            (current) => writeGpuState(current.gpu, warn),
            (error: Error) => warn(`gpu: settings could not be read for the GPU state: ${error.message}`),
        );
    };
    write();
    return settings.onSet(write);
};
