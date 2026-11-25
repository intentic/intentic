import { readFile, statfs } from "node:fs/promises";
import { cpus, freemem, loadavg, availableParallelism, platform, totalmem } from "node:os";
import { dirname } from "node:path";
import { errnoCode, undefinedIfMissing } from "@intentic/base/errors";
import { parseJsonWith } from "@intentic/base/json";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import type { HostStats } from "@intentic/sandbox-contract/schemas/deploys";
import { z } from "zod";
import { assertScope } from "../../policy.js";
import { type Docker, machineDocker, READ_TIMEOUT_MS, stacksRoot } from "./stacks.js";

/* HOW FULL THIS MACHINE IS (2026-11-25), for the deploys monitor's low-disk and low-memory alerts (HostStatsSchema in
   schemas/deploys.ts): free space where Docker keeps its images and volumes and where the stacks live, memory a new
   process could have, and load. Every figure is a cheap read; whatever cannot be read is left out rather than failing
   the rest, so a Docker that does not answer still leaves the stacks' disk, memory and load. */

type Disk = HostStats["disks"][number];

// The volume `path` is on, or undefined when it cannot be read. With `nearest`, by its nearest folder that exists: the
// stacks root before the first deploy is still on the disk it will be made on. Docker's root is read only where it is:
// inside Docker Desktop's VM it is no folder here, and the disk of its nearest parent here would be another disk.
const diskAt = async (role: Disk["role"], path: string, nearest: boolean): Promise<Disk | undefined> => {
    let at = path;
    for (;;) {
        try {
            // in order: each parent is asked only once its child is known not to be there
            const volume = await statfs(at);
            return { role, path, totalBytes: volume.blocks * volume.bsize, freeBytes: volume.bavail * volume.bsize };
        } catch (error) {
            if (!nearest || errnoCode(error) !== "ENOENT" || dirname(at) === at) {
                return undefined;
            }
            at = dirname(at);
        }
    }
};

// Where Docker keeps its data, as its engine says, or undefined when it does not answer.
const dockerRoot = async (docker: Docker): Promise<string | undefined> => {
    const result = await docker(["info", "--format", "{{json .DockerRootDir}}"], { timeoutMs: READ_TIMEOUT_MS });
    const root = result.status === 0 ? parseJsonWith(result.stdout.trim(), z.string()) : undefined;
    return root === undefined || root === "" ? undefined : root;
};

// Memory a new process could have without swapping. Linux says so itself (MemAvailable counts the page cache it would
// give back, which free memory does not); elsewhere free memory is the reading there is.
const availableMemory = async (): Promise<number> => {
    if (platform() !== "linux") {
        return freemem();
    }
    const meminfo = await readFile("/proc/meminfo", "utf8").catch(undefinedIfMissing);
    const kib = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo ?? "")?.[1];
    return kib === undefined ? freemem() : Number(kib) * 1024;
};

export const readHostStats = async (docker: Docker = machineDocker): Promise<HostStats> => {
    const root = await dockerRoot(docker);
    const [dockerDisk, stacksDisk, available] = await Promise.all([
        root === undefined ? undefined : diskAt("docker", root, false),
        diskAt("stacks", stacksRoot(), true),
        availableMemory(),
    ]);
    const [one = 0, five = 0, fifteen = 0] = loadavg();
    return {
        disks: [dockerDisk, stacksDisk].filter((disk) => disk !== undefined),
        memory: { totalBytes: totalmem(), availableBytes: available },
        load: [one, five, fifteen],
        cpus: cpus().length || availableParallelism(),
    };
};

export const hostStats = async (scopes: DeviceScopes, docker: Docker = machineDocker): Promise<string> => {
    assertScope(scopes, "shell");
    return JSON.stringify(await readHostStats(docker));
};
