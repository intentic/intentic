import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { cpus, loadavg, totalmem } from "node:os";
import type { RunnerFacts } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { GPU_LIBRARY_ENV, gpuHere, WSL_GPU_LIBRARY_PATH } from "../hosts/gpu/gpu-state.js";
import { type Pressure, readPressure } from "../system/resources/cgroup.js";
import { runCheck } from "../workload/run-check.js";
import { opt } from "../opt.js";
import type { BudgetSnapshot, ResourceBudget } from "../workload/resource-budget.js";

// How big one machine is and how full it is right now, read the same way here and on every runner: a runner answers
// its parent's `describe` with it (runner-service.ts), and the fleet advice measures this sandbox with it
// (fleet-advice.ts), so two machines are compared by one ruler. Every figure is a cheap read (os counters, one statfs,
// the budget's shared snapshot, a PSI file): nothing here starts a process or waits on one.

const MB = 1_048_576;

export interface OsReading {
    readonly cores: number;
    readonly totalMemoryBytes: number;
    // The one-minute load average, not yet divided by the cores.
    readonly loadOne: number;
}

export interface MachineFactsSources {
    readonly budget: Pick<ResourceBudget, "snapshot">;
    // Injected for tests; the real ones read procfs, cgroup files and the os module.
    readonly pressure?: () => Promise<Pressure>;
    readonly os?: () => OsReading;
    readonly disk?: (path: string) => Promise<{ readonly freeBytes: number } | undefined>;
    readonly gpus?: () => Promise<GpuFacts>;
}

type GpuFacts = NonNullable<RunnerFacts["gpus"]>;

const realOs = (): OsReading => ({
    cores: cpus().length,
    totalMemoryBytes: totalmem(),
    loadOne: loadavg()[0] ?? 0,
});

const realDisk = async (path: string): Promise<{ freeBytes: number } | undefined> => {
    // allow(silent-catch): a disk that can't be read reports nothing free, the answer a host should plan around.
    const disk = await statfs(path).catch(() => undefined);
    return disk === undefined ? undefined : { freeBytes: disk.bavail * disk.bsize };
};

const GPU_QUERY_MS = 5_000;
const NAMELESS: GpuFacts = [{ name: "GPU", memoryMb: 0 }];

// `name, memory MiB` per line, as nvidia-smi's csv query answers it.
export const parseGpuQuery = (text: string): GpuFacts =>
    text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => {
            const comma = line.lastIndexOf(",");
            const memory = Number(line.slice(comma + 1).trim());
            return { name: line.slice(0, comma).trim() || "GPU", memoryMb: Number.isFinite(memory) ? Math.max(0, Math.round(memory)) : 0 };
        });

// The GPUs passed through to this container, asked once per daemon: a GPU does not come and go while one runs. Only
// where gpuHere says a device node is there (the same test gpu-run makes), and only nvidia-smi's management query, which
// renders nothing; on WSL its libraries are where the engine mounts them. A GPU it cannot name is still a GPU.
const realGpus = async (): Promise<GpuFacts> => {
    if (!gpuHere()) {
        return [];
    }
    const libraries = process.env[GPU_LIBRARY_ENV] ?? WSL_GPU_LIBRARY_PATH;
    const wsl = existsSync(libraries);
    const tool = wsl && existsSync(`${libraries}/nvidia-smi`) ? `${libraries}/nvidia-smi` : "nvidia-smi";
    const ran = await runCheck({
        argv: [tool, "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
        env: wsl ? { ...process.env, LD_LIBRARY_PATH: libraries } : process.env,
        timeoutMs: GPU_QUERY_MS,
        workload: { class: "command" },
        kind: "probe",
        captureBytes: 4096,
    });
    // A GPU whose tool is missing or slow is still there; it is only nameless.
    const gpus = ran.exitCode === 0 ? parseGpuQuery(ran.stdout) : [];
    return gpus.length > 0 ? gpus : NAMELESS;
};
let gpusOnce: Promise<GpuFacts> | undefined;
const cachedGpus = (): Promise<GpuFacts> => {
    gpusOnce ??= realGpus();
    return gpusOnce;
};

// The budget's own reading, not a second one: what the turn door admits by is what "free" means everywhere.
const budgetFigures = (snapshot: BudgetSnapshot | undefined): Pick<RunnerFacts, "memoryFreeMb" | "memoryLimitMb" | "memoryStall"> => {
    if (snapshot === undefined) {
        return {};
    }
    const limit = snapshot.reading.limitBytes;
    return {
        ...opt("memoryFreeMb", snapshot.freeBytes === undefined ? undefined : Math.max(0, Math.floor(snapshot.freeBytes / MB))),
        ...opt("memoryLimitMb", limit === undefined || limit <= 0 ? undefined : Math.max(1, Math.round(limit / MB))),
        memoryStall: snapshot.reading.stallPercent,
    };
};

// freeDiskMb is read where the workspace lives, which is the disk a turn actually fills.
export const machineFacts = async (workspaceRoot: string, sources: MachineFactsSources): Promise<RunnerFacts> => {
    const os = (sources.os ?? realOs)();
    const [disk, snapshot, pressure, gpus] = await Promise.all([
        (sources.disk ?? realDisk)(workspaceRoot),
        // allow(silent-catch): a budget that cannot read its files measures nothing, and the facts say so by omission.
        sources.budget.snapshot().catch(() => undefined),
        // allow(silent-catch): a kernel without PSI reports no pressure, which the schema already reads as absent.
        (sources.pressure ?? readPressure)().catch(() => undefined),
        (sources.gpus ?? cachedGpus)(),
    ]);
    const cores = Math.max(1, os.cores);
    return {
        cpus: cores,
        memoryMb: Math.max(1, Math.round(os.totalMemoryBytes / MB)),
        freeDiskMb: disk === undefined ? 0 : Math.round(disk.freeBytes / MB),
        // Normalised to core count, so "1" means saturated on any machine size; answers "is it busy right now".
        load: Math.round((os.loadOne / cores) * 100) / 100,
        ...budgetFigures(snapshot),
        ...opt("cpuPressure", pressure?.cpu?.some),
        gpus,
    };
};
