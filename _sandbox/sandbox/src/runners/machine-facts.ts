import { existsSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import type { HostRoom } from "@intentic/constants/memory-room";
import type { RunnerFacts } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { MachineHost } from "@intentic/sandbox-contract/schemas/offload";
import { GPU_LIBRARY_ENV, gpuHere, WSL_GPU_LIBRARY_PATH } from "../hosts/gpu/gpu-state.js";
import { type Pressure, readPressure } from "../system/resources/cgroup.js";
import { readHistorySpace } from "../system/resources/storage/checkout-admission.js";
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

/* A RUNNER'S DISK IS THE WINDOWS DRIVE UNDER ITS ENGINE WHERE THAT IS TIGHTER (2026-11-24). Inside a container on Docker
   Desktop a statfs reads the engine's virtual disk, which grows on its Windows drive up to a terabyte, so omen's runner
   kept reading hundreds of gigabytes free while C: went to 0: ten subagents were placed there at 02:06, Docker Desktop
   died at 05:12 and took the runner and every one of their turns with it. Read through the host drive's hint, as the
   sandbox's own checkouts are (checkout-admission.ts readHistorySpace); where ic gives none, the statfs stands. The
   unprivileged figure, as before: what any writer there can still use. */
const realDisk = async (path: string): Promise<{ freeBytes: number } | undefined> => {
    // allow(silent-catch): a disk that can't be read reports nothing free, the answer a host should plan around.
    const space = await readHistorySpace(path, false).catch(() => undefined);
    return space === undefined ? undefined : { freeBytes: space.freeBytes };
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

/* THE HOST'S OWN MEMORY IS PART OF A MACHINE'S ROOM (2026-11-24). A sandbox or runner on a Windows PC measures its cgroup
   and the WSL2 VM under it, never Windows, and one VM holds every tenant of that PC: each sandbox's runner, the owner's
   CI runners, `devices exec` work in a distro. On 2026-11-23 omen's Windows sat at 0.3 to 3 GiB available of 31.6 for
   four hours while the intentic and shinobi-society runners there (22 GiB caps each, in a 26 GiB VM) both read as
   roomy; the parents kept placing sessions and subagents on them until the machine froze (its agent's event loop stalled
   185 s), and Docker's engine died at 23:19 with five turns on it. So a machine's free memory is never more than what its
   host has above the line under which it thrashes (hosts.ts hostMemoryLowBytes, the reserve heavy work already keeps),
   less what was admitted and does not show yet. The host part comes from that machine's agent (host-room.ts): for this
   sandbox the budget's own reading carries it, and for a runner the parent joins it from the heartbeat of the device the
   runner runs on (fleet-advice.ts readRunners). Absent, it constrains nothing. */
const hostRoomMb = (host: HostRoom, reservedBytes = 0): number =>
    Math.max(0, Math.floor((host.availableBytes - host.reserveBytes - reservedBytes) / MB));

// A machine's facts with its host's room folded into what it has free. Unchanged without a host part.
export const onHost = (facts: RunnerFacts, host: HostRoom | undefined): RunnerFacts => {
    if (host === undefined) {
        return facts;
    }
    const room = hostRoomMb(host);
    return { ...facts, memoryFreeMb: Math.min(facts.memoryFreeMb ?? room, room) };
};

// What the budget itself has free, before its host is asked.
const ownFreeMbOf = (snapshot: BudgetSnapshot): number | undefined =>
    snapshot.freeBytes === undefined ? undefined : Math.max(0, Math.floor(snapshot.freeBytes / MB));

// What the budget has free, never more than its host has room for (above).
const freeMbOf = (snapshot: BudgetSnapshot): number | undefined => {
    const own = ownFreeMbOf(snapshot);
    const { host } = snapshot.reading;
    if (host === undefined) {
        return own;
    }
    const room = hostRoomMb(host, snapshot.reservedBytes);
    return own === undefined ? room : Math.min(own, room);
};

const mbOf = (bytes: number): number => Math.max(0, Math.round(bytes / MB));

/** The computer under this machine in the figures its owner can check (offload.ts MachineHostSchema), and whether its room
 *  is what this machine's free memory came to; undefined where the reading has no host part. */
const hostOf = (snapshot: BudgetSnapshot | undefined): MachineHost | undefined => {
    const host = snapshot?.reading.host;
    if (snapshot === undefined || host === undefined) {
        return undefined;
    }
    const own = ownFreeMbOf(snapshot);
    return {
        name: host.name,
        availableMb: mbOf(host.availableBytes),
        totalMb: Math.max(1, mbOf(host.totalBytes)),
        reserveMb: mbOf(host.reserveBytes),
        ...opt("vmMb", host.vmBytes === undefined ? undefined : mbOf(host.vmBytes)),
        ...opt("vmUnusedMb", host.vmUnusedBytes === undefined ? undefined : mbOf(host.vmUnusedBytes)),
        ...opt("ownFreeMb", own),
        binding: own === undefined || hostRoomMb(host, snapshot.reservedBytes) < own,
    };
};

// The budget's own reading, not a second one: what the turn door admits by is what "free" means everywhere.
export const budgetFigures = (snapshot: BudgetSnapshot | undefined): Pick<RunnerFacts, "memoryFreeMb" | "memoryLimitMb" | "memoryStall"> => {
    if (snapshot === undefined) {
        return {};
    }
    const limit = snapshot.reading.limitBytes;
    return {
        ...opt("memoryFreeMb", freeMbOf(snapshot)),
        ...opt("memoryLimitMb", limit === undefined || limit <= 0 ? undefined : Math.max(1, Math.round(limit / MB))),
        memoryStall: snapshot.reading.stallPercent,
    };
};

// This sandbox's facts with the computer under it beside them (fleet-advice.ts readHere). What a runner answers its parent
// leaves the host out: the parent reads that computer from its own heartbeat (fleet-advice.ts readRunners).
export type HereFacts = RunnerFacts & { readonly host?: MachineHost };

// freeDiskMb is read where the workspace lives, which is the disk a turn actually fills.
const measured = async (
    workspaceRoot: string,
    sources: MachineFactsSources,
): Promise<{ readonly facts: RunnerFacts; readonly snapshot: BudgetSnapshot | undefined }> => {
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
    const facts: RunnerFacts = {
        cpus: cores,
        memoryMb: Math.max(1, Math.round(os.totalMemoryBytes / MB)),
        freeDiskMb: disk === undefined ? 0 : Math.round(disk.freeBytes / MB),
        // Normalised to core count, so "1" means saturated on any machine size; answers "is it busy right now".
        load: Math.round((os.loadOne / cores) * 100) / 100,
        ...budgetFigures(snapshot),
        ...opt("cpuPressure", pressure?.cpu?.some),
        gpus,
    };
    return { facts, snapshot };
};

export const machineFacts = async (workspaceRoot: string, sources: MachineFactsSources): Promise<RunnerFacts> =>
    (await measured(workspaceRoot, sources)).facts;

export const hereFacts = async (workspaceRoot: string, sources: MachineFactsSources): Promise<HereFacts> => {
    const { facts, snapshot } = await measured(workspaceRoot, sources);
    return { ...facts, ...opt("host", hostOf(snapshot)) };
};
