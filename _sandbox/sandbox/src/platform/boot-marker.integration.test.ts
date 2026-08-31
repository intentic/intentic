import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Logger, pino } from "pino";
import { expect, test } from "vitest";
import { claimBootMarker } from "./boot-marker.js";
import { processIdentity, type ProcessIdentity } from "./proc-stat.js";

const setup = async (): Promise<{ dir: string; lines: object[]; logger: Logger }> => {
    const dir = await mkdtemp(join(tmpdir(), "boot-marker-"));
    const lines: object[] = [];
    const logger = pino({ level: "debug" }, { write: (line: string) => void lines.push(JSON.parse(line) as object) });
    return { dir, lines, logger };
};

const self = (): ProcessIdentity => {
    const identity = processIdentity();
    if (identity === undefined) {
        throw new Error("procfs did not identify the test process");
    }
    return identity;
};

// A pid that is certainly gone: a process that has already exited. A made-up number is a corpse only until the
// container happens to be running that many processes: a hardcoded 4242 was alive in CI, and every death
// certificate here came back as a co-tenant notice instead.
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid;

test("a first boot claims the marker quietly and a clean exit rewrites it", async () => {
    const { dir, lines, logger } = await setup();
    const marker = claimBootMarker(dir, logger);
    expect(lines).toEqual([]);
    expect(JSON.parse(await readFile(join(dir, "daemon-exit.json"), "utf8"))).toMatchObject({ state: "running", ...self() });

    marker.markExited(0);
    expect(JSON.parse(await readFile(join(dir, "daemon-exit.json"), "utf8"))).toMatchObject({ state: "exited", exitCode: 0 });
});

test("a marker still saying running is reported as an unannounced death", async () => {
    const { dir, lines, logger } = await setup();
    const died = deadPid();
    await writeFile(join(dir, "daemon-exit.json"), JSON.stringify({ state: "running", pid: died, startTimeTicks: 1, startedAt: 1_000 }));
    claimBootMarker(dir, logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 50, diedPid: died });
    expect(lines[0]).not.toHaveProperty("fatalReports");
    expect(lines[0]).not.toHaveProperty("ownerPid");
});

test("a fatal-error report left by the dead pid is named in the death certificate", async () => {
    const { dir, lines, logger } = await setup();
    const died = deadPid();
    const other = died + 1;
    const report = `report.20260730.161314.${died}.0.json`;
    await writeFile(join(dir, "daemon-exit.json"), JSON.stringify({ state: "running", pid: died, startTimeTicks: 1, startedAt: 1_000 }));
    await writeFile(join(dir, report), "{}");
    // Another pid's report must not be attributed to this death.
    await writeFile(join(dir, `report.20260730.161314.${other}.0.json`), "{}");
    claimBootMarker(dir, logger);
    expect(lines[0]).toMatchObject({ level: 50, diedPid: died, fatalReports: [report] });
    expect(JSON.stringify(lines[0])).not.toContain(`${other}.0.json`);
});

test("a marker whose owner is still running is a co-tenant, not a corpse, and its record is left alone", async () => {
    const { dir, lines, logger } = await setup();
    const identity = self();
    const owner = JSON.stringify({ state: "running", ...identity, startedAt: 1_000 });
    await writeFile(join(dir, "daemon-exit.json"), owner);
    const marker = claimBootMarker(dir, logger);
    expect(lines[0]).toMatchObject({ level: 40, ownerPid: identity.pid, logsDir: dir });
    expect(lines[0]).not.toHaveProperty("diedPid");
    expect(await readFile(join(dir, "daemon-exit.json"), "utf8")).toBe(owner);

    // And its exit hook stays a no-op: this run's end says nothing about the run that owns the marker.
    marker.markExited(0);
    expect(await readFile(join(dir, "daemon-exit.json"), "utf8")).toBe(owner);
});

test("a clean previous exit stays quiet", async () => {
    const { dir, lines, logger } = await setup();
    await writeFile(
        join(dir, "daemon-exit.json"),
        JSON.stringify({ state: "exited", pid: 4242, startTimeTicks: 1, startedAt: 1_000, endedAt: 2_000, exitCode: 0 }),
    );
    claimBootMarker(dir, logger);
    expect(lines).toEqual([]);
});

test("a running marker whose pid was recycled is a death certificate, not a live co-tenant", async () => {
    const { dir, lines, logger } = await setup();
    const identity = self();
    await writeFile(
        join(dir, "daemon-exit.json"),
        JSON.stringify({ state: "running", ...identity, startTimeTicks: identity.startTimeTicks - 1, startedAt: 1_000 }),
    );

    claimBootMarker(dir, logger);

    expect(lines[0]).toMatchObject({ level: 50, diedPid: identity.pid });
    expect(lines[0]).not.toHaveProperty("ownerPid");
});
