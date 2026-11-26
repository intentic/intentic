import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStatsSchema } from "@intentic/sandbox-contract/schemas/device-stacks";
import { dockerAnswered, fakeDocker, grantWith } from "../../device-testing.js";
import { ScopeError } from "../../policy.js";
import { hostStats, readHostStats } from "./host-stats.js";
import { stacksRoot } from "./stacks.js";

// host_stats on this machine's real disks, memory and load (statfs, /proc/meminfo, os), Docker a fake: `suites` gives
// the run a throwaway HOME, whose stacks root no deploy has made yet.

test("host_stats needs 'Run commands', and reads Docker's data root and the stacks folder's disks, memory, load and cpus", async () => {
    await expect(hostStats(grantWith(), fakeDocker().docker)).rejects.toBeInstanceOf(ScopeError);
    const dockerRoot = mkdtempSync(join(tmpdir(), "docker-root-"));
    const { docker, calls } = fakeDocker({ respond: (args) => (args[0] === "info" ? dockerAnswered(`${JSON.stringify(dockerRoot)}\n`) : undefined) });

    const stats = HostStatsSchema.parse(JSON.parse(await hostStats(grantWith(["shell"]), docker)));

    expect(calls.map((call) => call.args)).toEqual([["info", "--format", "{{json .DockerRootDir}}"]]);
    expect(stats.disks.map((disk) => [disk.role, disk.path])).toEqual([
        ["docker", dockerRoot],
        ["stacks", stacksRoot()],
    ]);
    for (const disk of stats.disks) {
        expect(disk.totalBytes).toBeGreaterThan(0);
        expect(disk.freeBytes).toBeGreaterThanOrEqual(0);
        expect(disk.freeBytes).toBeLessThanOrEqual(disk.totalBytes);
    }
    expect(stats.memory.availableBytes).toBeGreaterThan(0);
    expect(stats.memory.availableBytes).toBeLessThanOrEqual(stats.memory.totalBytes);
    expect(stats.load).toHaveLength(3);
    expect(stats.cpus).toBeGreaterThanOrEqual(1);
});

test("a Docker that does not answer, or whose data root is not on this machine, leaves only the docker disk out", async () => {
    const down = fakeDocker({ respond: () => ({ status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon\n" }) });
    expect((await readHostStats(down.docker)).disks.map((disk) => disk.role)).toEqual(["stacks"]);
    const elsewhere = fakeDocker({ respond: () => dockerAnswered('"/var/lib/docker-inside-a-vm-that-is-not-here"\n') });
    expect((await readHostStats(elsewhere.docker)).disks.map((disk) => disk.role)).toEqual(["stacks"]);
});
