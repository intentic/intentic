import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec, type FakeRunner, fakeSys, runnerPrograms, tempDir, testConfig, testContext } from "../ci-fleet-testing.js";
import { JanitorConfigSchema } from "../janitor/janitor-config.js";
import { PruneConfigSchema } from "./prune-config.js";
import { fullPassMode, type PruneDisk, runPrunePass } from "./prune.js";
import { ciContainersToRemove, createdAtMs } from "./stopped-containers.js";

/* The host prune against a docker that only records what it is asked (linux-host-prune.test.mjs's cases, ported): a
   deployment's container, network or named volume is never in what it removes, stopped or not. On z440 the script it
   replaces removed a Komodo-run sandbox's container a day after the keeper put it to sleep, then its volumes with
   `volume prune -a` (2026-11-12), and the auto-translate stack's data after a reboot (2026-11-17). */

const NOW = Date.parse("2026-11-24T12:00:00Z");
const HOUR = 3_600_000;

// docker's CreatedAt format, in UTC.
const createdAt = (hoursAgo: number): string => `${new Date(NOW - hoursAgo * HOUR).toISOString().slice(0, 19).replace("T", " ")} +0000 UTC`;

interface Options {
    readonly containers?: string[][];
    readonly ingest?: boolean;
    readonly percent?: number;
    readonly runners?: FakeRunner[];
    readonly dryRun?: boolean;
    readonly root?: string;
    // When the last full pass was, by its stamp; none is a host that never had one.
    readonly lastFullHoursAgo?: number;
}

const prune = async (options: Options = {}) => {
    const root = options.root ?? tempDir("ci-prune-");
    const listing = (options.containers ?? []).map((row) => `${row.join("\t")}\n`).join("");
    const answer = (command: string, args: readonly string[]) => {
        if (command === "docker") {
            return args[0] === "container" && args[1] === "ls" ? exec(listing) : exec("");
        }
        if (command === "ctr") {
            return exec(`REF\tSIZE\tAGE\n${options.ingest === true ? "tar-blobs/sha256/2fbb\t118558746\t47s\n" : ""}`);
        }
        return command === "systemctl" ? exec("") : undefined;
    };
    const sys = fakeSys({ programs: runnerPrograms(options.runners ?? [], answer), now: NOW });
    const config = testConfig({
        prune: PruneConfigSchema.parse({ enabled: true, runnerCache: join(root, "runner-cache") }),
        janitor: JanitorConfigSchema.parse({ runnersGlob: join(root, "actions-runner-*") }),
    });
    const { context } = await testContext(sys, config);
    if (options.lastFullHoursAgo !== undefined) {
        const stamp = join(config.stateDir, "prune-full-at");
        const at = (NOW - options.lastFullHoursAgo * HOUR) / 1000;
        writeFileSync(stamp, "");
        utimesSync(stamp, at, at);
    }
    const disk: PruneDisk = { percent: async () => await Promise.resolve(options.percent ?? 50), line: async () => await Promise.resolve("1 GB used, 1 GB free on /") };
    const pass = await runPrunePass(context, { dryRun: options.dryRun ?? false, disk });
    const calls = sys.calls.filter((call) => call[0] === "docker").map((call) => call.slice(1).join(" "));
    return { pass, calls, context, sys };
};

test("only a CI container stopped for over a day is removed; a deployment's never is", async () => {
    const { calls } = await prune({
        containers: [
            ["old-ci", createdAt(30), "", ""],
            ["young-ci", createdAt(2), "", ""],
            ["komodo-stack", createdAt(30), "auto-translate", ""],
            ["asleep-sandbox", createdAt(30), "", "sandbox"],
            ["compose-sandbox", createdAt(30), "translations-sandbox", "sandbox"],
            ["unparseable", "sometime", "", ""],
        ],
    });
    expect(calls.filter((call) => call.startsWith("container rm"))).toEqual(["container rm old-ci"]);
    expect(calls.some((call) => call.startsWith("container prune"))).toBe(false);
});

test("nothing to remove asks docker to remove nothing", async () => {
    const { calls } = await prune({ containers: [["komodo-stack", createdAt(30), "auto-translate", ""]] });
    expect(calls.some((call) => call.startsWith("container rm"))).toBe(false);
});

test("the volume prune takes anonymous volumes and testcontainers', never every unused named one", async () => {
    const { calls } = await prune();
    expect(calls.filter((call) => call.startsWith("volume prune"))).toEqual(["volume prune -f", "volume prune -af --filter label=org.testcontainers=true"]);
});

test("the network prune leaves a compose project's networks", async () => {
    const { calls } = await prune();
    expect(calls.filter((call) => call.startsWith("network prune"))).toEqual(["network prune -f --filter until=24h --filter label!=com.docker.compose.project"]);
});

test("images and build cache wait while docker is writing an image; volumes do not", async () => {
    const writing = await prune({ ingest: true });
    expect(writing.calls.some((call) => /^(image|builder) prune/u.test(call))).toBe(false);
    expect(writing.calls).toContain("volume prune -f");
    const quiet = await prune();
    expect(quiet.calls).toContain("image prune -f --filter until=1h");
    expect(quiet.calls).toContain("builder prune -f --max-used-space 40GB");
    expect(quiet.calls).toContain("image prune -af --filter until=48h");
});

test("a busy host waits for an idle moment, unless it is overdue or the disk is past its pressure line", async () => {
    const runners: FakeRunner[] = [{ unit: "actions.runner.intentic-intentic.w1.service", dir: "/r/1", worker: 7 }];
    const busy = await prune({ runners, lastFullHoursAgo: 3 });
    expect(busy.calls.some((call) => /^(image|volume|builder) prune/u.test(call))).toBe(false);
    expect(busy.pass.lines).toContain("full pass: waiting for an idle moment (last one 3h ago, forced at 24h)");
    expect(busy.pass.lines[0]).toBe("start: 50% of / used; jobs running: 1");
    // A host busy for a day gets its full pass anyway, and one that never had one is overdue at once.
    expect((await prune({ runners, lastFullHoursAgo: 25 })).pass.lines).toContain("full pass (overdue)");
    expect((await prune({ runners })).pass.lines).toContain("full pass (overdue)");
    // Pressure takes everything unused, even while docker writes an image, and calls the janitor if that was not enough.
    const pressed = await prune({ runners, percent: 85, ingest: true, lastFullHoursAgo: 1 });
    expect(pressed.calls).toEqual(expect.arrayContaining(["image prune -af", "builder prune -af"]));
    expect(pressed.pass.lines).toContain("still 85% used after pruning docker; starting the janitor for /ci-cache");
});

test("the full pass's mode: pressure first, then idle, then overdue", () => {
    const config = PruneConfigSchema.parse({});
    expect(fullPassMode(80, false, 0, config)).toBe("pressure");
    expect(fullPassMode(79, true, 0, config)).toBe("idle");
    expect(fullPassMode(79, false, 24, config)).toBe("overdue");
    expect(fullPassMode(79, false, 23, config)).toBeUndefined();
});

test("a dry run says what it would run and removes nothing", async () => {
    const root = tempDir("ci-prune-");
    const diag = join(root, "actions-runner-1", "_diag");
    mkdirSync(diag, { recursive: true });
    const old = (NOW - 20 * 24 * HOUR) / 1000;
    writeFileSync(join(diag, "Worker_old.log"), "x");
    utimesSync(join(diag, "Worker_old.log"), old, old);
    writeFileSync(join(diag, "Worker_new.log"), "x");
    const cache = join(root, "runner-cache");
    mkdirSync(cache);
    writeFileSync(join(cache, "actions-runner-linux-x64-2.328.0.tar.gz"), "x");
    utimesSync(join(cache, "actions-runner-linux-x64-2.328.0.tar.gz"), old, old);
    writeFileSync(join(cache, "actions-runner-linux-x64-2.329.0.tar.gz"), "x");
    const { pass, calls } = await prune({ root, dryRun: true, containers: [["old-ci", createdAt(30), "", ""]] });
    expect(calls.filter((call) => !call.startsWith("container ls") && call !== "version")).toEqual([]);
    expect(pass.lines).toEqual(
        expect.arrayContaining([
            "would run: docker container rm old-ci",
            `would remove 1 runner logs older than 14d in ${diag}`,
            `would run: rm -f -- ${join(cache, "actions-runner-linux-x64-2.328.0.tar.gz")}`,
            "would run: docker volume prune -f",
        ]),
    );
    expect(readdirSync(diag)).toHaveLength(2);
    expect(readdirSync(cache)).toHaveLength(2);
});

test("a real pass removes the old logs and the superseded tarball, and restarts docker once idle when asked", async () => {
    const root = tempDir("ci-prune-");
    const diag = join(root, "actions-runner-1", "_diag");
    mkdirSync(diag, { recursive: true });
    const old = (NOW - 20 * 24 * HOUR) / 1000;
    writeFileSync(join(diag, "Worker_old.log"), "x");
    utimesSync(join(diag, "Worker_old.log"), old, old);
    writeFileSync(join(diag, "Runner_old.txt"), "x");
    utimesSync(join(diag, "Runner_old.txt"), old, old);
    const { context, sys } = await prune({ root });
    expect(readdirSync(diag)).toEqual(["Runner_old.txt"]);
    expect(context.status.read().prune?.lines[0]).toBe("start: 50% of / used; no job running");
    writeFileSync(join(context.config.stateDir, "docker-restart-pending"), "");
    await runPrunePass(context, { dryRun: false, disk: { percent: async () => await Promise.resolve(10), line: async () => await Promise.resolve("") } });
    expect(sys.calls).toContainEqual(["systemctl", "restart", "docker"]);
    expect(existsSync(join(context.config.stateDir, "docker-restart-pending"))).toBe(false);
});

test("a computer whose prune is off refuses a pass, and docker's dates read as docker prints them", async () => {
    const { context } = await testContext(fakeSys());
    await expect(runPrunePass(context, { dryRun: true })).rejects.toThrow(/ci-fleet install --prune/u);
    expect(createdAtMs("2026-11-17 10:27:39 -0500 EST")).toBe(Date.parse("2026-11-17T15:27:39Z"));
    expect(ciContainersToRemove("a\tnot a date\t\t\n", NOW)).toEqual([]);
});
