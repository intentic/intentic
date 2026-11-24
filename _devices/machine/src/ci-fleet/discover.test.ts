import { exec, fakeSys, runnerFiles, runnerPrograms } from "./ci-fleet-testing.js";
import { discoverRunners, expandGlob, jobOfWorkerLog, nameOfUnit, parseElapsed, parseRunnerFile, parseShowBlocks, parseUnitFiles, parseWorkers, versionOfBinLink } from "./discover.js";

/* The runners as systemd, the process table and the runners' own files describe them, read without a systemd: the
   fixtures are what systemd 257, procps 4 and runner 2.329 print on z440 and in omen's distro, the names kept. */

test("unit files are read off `list-unit-files`, and only the runner units among them", () => {
    const printed = [
        "actions.runner.intentic-intentic.z440-worker-1.service enabled enabled",
        "actions.runner.intentic-intentic.z440-light-1.service  disabled enabled",
        "intentic-ci-janitor.service static -",
        "",
    ].join("\n");
    expect(parseUnitFiles(printed)).toEqual(["actions.runner.intentic-intentic.z440-worker-1.service", "actions.runner.intentic-intentic.z440-light-1.service"]);
});

test("`systemctl show` for several units reads as one block each, a value with '=' in it kept whole", () => {
    const blocks = parseShowBlocks("Id=a.service\nActiveState=active\nEnvironment=A=b\n\nId=b.service\nActiveState=failed\n");
    expect(blocks.map((block) => [block.get("Id"), block.get("ActiveState")])).toEqual([
        ["a.service", "active"],
        ["b.service", "failed"],
    ]);
    expect(blocks[0]?.get("Environment")).toBe("A=b");
});

test("a live worker is placed under the runner folder its binary runs from, whatever version folder it is in", () => {
    const printed = "4242 /home/radarsu/actions-runner-1/bin.2.329.0/Runner.Worker spawnclient 101 104\n5151 /home/radarsu/actions-runner-2/bin/Runner.Worker spawnclient 9 12\n";
    expect([...parseWorkers(printed)]).toEqual([
        ["/home/radarsu/actions-runner-1", 4242],
        ["/home/radarsu/actions-runner-2", 5151],
    ]);
    expect([...parseElapsed("4242   75\n 5151 3600\n")]).toEqual([
        [4242, 75],
        [5151, 3600],
    ]);
});

test("a runner's name, version and job are read where they are said, and nothing is made up where they are not", () => {
    expect(parseRunnerFile('﻿{"agentName":"z440-worker-1","gitHubUrl":"https://github.com/intentic/intentic"}')?.agentName).toBe("z440-worker-1");
    expect(parseRunnerFile("not json")).toBeUndefined();
    expect(versionOfBinLink("bin.2.329.0")).toBe("2.329.0");
    expect(versionOfBinLink("/home/r/actions-runner-1/bin.2.330.1")).toBe("2.330.1");
    expect(versionOfBinLink(undefined)).toBeUndefined();
    expect(nameOfUnit("actions.runner.intentic-intentic.radarsu-worker-3.service")).toBe("radarsu-worker-3");
    expect(jobOfWorkerLog('[2026-11-24 10:00:00Z INFO Worker] Job message:\n {"jobDisplayName": "verify (web)", "x": 1}')).toBe("verify (web)");
    expect(jobOfWorkerLog("[2026-11-24 10:00:00Z INFO Worker] Waiting for job")).toBeUndefined();
});

test("the fleet: names from each .runner, busy runners with their job and since when, holds and a smoke pause said", async () => {
    const runners = [
        { unit: "actions.runner.intentic-intentic.z440-worker-1.service", dir: "/home/runner/actions-runner-1", name: "z440-worker-1", worker: 4242, elapsed: 120 },
        { unit: "actions.runner.intentic-intentic.z440-worker-2.service", dir: "/home/runner/actions-runner-2", name: "z440-worker-2", state: "inactive" },
        { unit: "actions.runner.intentic-intentic.z440-light-1.service", dir: "/home/runner/actions-runner-light-1", state: "inactive", dropIns: "/run/systemd/system/x.d/intentic-paused.conf" },
    ];
    const files = runnerFiles(runners);
    files.set("/home/runner/actions-runner-1/_diag/Worker_20261124-115800-utc.log", '"jobDisplayName": "unit (sandbox)"');
    files.set("/run/intentic-ci/workers-paused", "");
    const sys = fakeSys({
        programs: runnerPrograms(runners),
        files,
        dirs: new Map([["/home/runner/actions-runner-1/_diag", ["Runner_20261120.log", "Worker_20261124-110000-utc.log", "Worker_20261124-115800-utc.log"]]]),
        links: new Map([["/home/runner/actions-runner-1/bin", "bin.2.329.0"]]),
    });
    const { runners: found, workerPids } = await discoverRunners(sys, { "z440-worker-2": { hold: "board", at: "2026-11-24T11:00:00Z", draining: false, after: "stay" } });
    expect(found.map((runner) => [runner.name, runner.state, runner.busy, runner.held, runner.light])).toEqual([
        ["z440-light-1", "inactive", false, "smoke", true],
        ["z440-worker-1", "active", true, undefined, false],
        ["z440-worker-2", "inactive", false, "board", false],
    ]);
    const busy = found.find((runner) => runner.name === "z440-worker-1");
    expect(busy).toMatchObject({ job: "unit (sandbox)", version: "2.329.0", busySince: "2026-11-24T11:58:00.000Z", url: "https://github.com/intentic/intentic", user: "runner" });
    expect([...workerPids]).toEqual([["z440-worker-1", 4242]]);
});

test("a computer with no runner units and no runner folders is an empty fleet, asked nothing past the unit list", async () => {
    const sys = fakeSys({ programs: (command) => (command === "systemctl" ? exec("") : undefined) });
    expect((await discoverRunners(sys)).runners).toEqual([]);
    expect(sys.calls).toHaveLength(1);
});

test("a unit list that matches nothing, which systemd 257 says as exit 1 and no output, is an empty list", async () => {
    const sys = fakeSys({ programs: (command) => (command === "systemctl" ? exec("", 1) : undefined) });
    expect((await discoverRunners(sys)).runners).toEqual([]);
});

test("a runner folder whose unit systemd no longer has is listed as not installed, as z440's were on 2026-11-24", async () => {
    const dir = "/home/radarsu/actions-runner-1";
    const files = runnerFiles([{ unit: "x", dir, name: "z440-worker-1" }]);
    files.set(`${dir}/.service`, "actions.runner.intentic-intentic.z440-worker-1.service\n");
    files.set("/home/radarsu/actions-runner-9/.service", "not a unit\n");
    const sys = fakeSys({
        programs: (command) => (command === "systemctl" ? exec("", 1) : command === "pgrep" ? exec("", 1) : undefined),
        files,
        dirs: new Map([
            ["/", ["home", "root"]],
            ["/home", ["radarsu", "lost+found"]],
            ["/home/radarsu", ["actions-runner-1", "actions-runner-9", "notes.txt"]],
        ]),
    });
    const { runners } = await discoverRunners(sys);
    expect(runners.map((runner) => [runner.name, runner.state, runner.user, runner.unit])).toEqual([
        ["z440-worker-1", "not-installed", "radarsu", "actions.runner.intentic-intentic.z440-worker-1.service"],
    ]);
});

test("a glob expands segment by segment, matching names only where a segment has a star", async () => {
    const sys = fakeSys({ dirs: new Map([["/", ["home"]], ["/home", ["a", "b.c"]], ["/home/a", ["actions-runner-1", "x"]], ["/home/b.c", ["actions-runner-light-1"]]]) });
    expect(await expandGlob(sys, "/home/*/actions-runner-*")).toEqual(["/home/a/actions-runner-1", "/home/b.c/actions-runner-light-1"]);
});

test("a systemd that fails the listing is an error in its own words, never an empty fleet", async () => {
    const sys = fakeSys({ programs: () => exec("", 1, "Failed to connect to bus: No such file or directory") });
    await expect(discoverRunners(sys)).rejects.toThrow(/Failed to connect to bus/u);
});
