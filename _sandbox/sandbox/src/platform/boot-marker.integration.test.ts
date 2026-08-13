import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Logger, pino } from "pino";
import { expect, test } from "vitest";
import { claimBootMarker } from "./boot-marker.js";

const setup = async (): Promise<{ dir: string; lines: object[]; logger: Logger }> => {
    const dir = await mkdtemp(join(tmpdir(), "boot-marker-"));
    const lines: object[] = [];
    const logger = pino({ level: "debug" }, { write: (line: string) => void lines.push(JSON.parse(line) as object) });
    return { dir, lines, logger };
};

// A pid that is certainly gone: a process that has already exited. A made-up number is a corpse only until the
// container happens to be running that many processes — a hardcoded 4242 was alive in CI, and every death
// certificate here came back as a co-tenant notice instead.
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid;

test("a first boot claims the marker quietly and a clean exit rewrites it", async () => {
    const { dir, lines, logger } = await setup();
    const marker = claimBootMarker(dir, logger);
    expect(lines).toEqual([]);
    expect(JSON.parse(await readFile(join(dir, "daemon-exit.json"), "utf8"))).toMatchObject({ state: "running", pid: process.pid });

    marker.markExited(0);
    expect(JSON.parse(await readFile(join(dir, "daemon-exit.json"), "utf8"))).toMatchObject({ state: "exited", exitCode: 0 });
});

test("a marker still saying running is reported as an unannounced death", async () => {
    const { dir, lines, logger } = await setup();
    const died = deadPid();
    await writeFile(join(dir, "daemon-exit.json"), JSON.stringify({ state: "running", pid: died, startedAt: 1_000 }));
    claimBootMarker(dir, logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 50, diedPid: died });
    expect(JSON.stringify(lines[0])).toContain("killed without warning");
});

test("a fatal-error report left by the dead pid is named in the death certificate", async () => {
    const { dir, lines, logger } = await setup();
    const died = deadPid();
    const other = died + 1;
    await writeFile(join(dir, "daemon-exit.json"), JSON.stringify({ state: "running", pid: died, startedAt: 1_000 }));
    await writeFile(join(dir, `report.20260730.161314.${died}.0.json`), "{}");
    // Another pid's report must not be attributed to this death.
    await writeFile(join(dir, `report.20260730.161314.${other}.0.json`), "{}");
    claimBootMarker(dir, logger);
    expect(JSON.stringify(lines[0])).toContain(`report.20260730.161314.${died}.0.json`);
    expect(JSON.stringify(lines[0])).not.toContain(`${other}.0.json`);
    expect(JSON.stringify(lines[0])).toContain("died on a fatal error");
});

test("a marker whose owner is still running is a co-tenant, not a corpse — and its record is left alone", async () => {
    const { dir, lines, logger } = await setup();
    const owner = JSON.stringify({ state: "running", pid: process.pid, startedAt: 1_000 });
    await writeFile(join(dir, "daemon-exit.json"), owner);
    const marker = claimBootMarker(dir, logger);
    expect(JSON.stringify(lines[0])).toContain("another live daemon owns this history root");
    expect(await readFile(join(dir, "daemon-exit.json"), "utf8")).toBe(owner);

    // And its exit hook stays a no-op: this run's end says nothing about the run that owns the marker.
    marker.markExited(0);
    expect(await readFile(join(dir, "daemon-exit.json"), "utf8")).toBe(owner);
});

test("a clean previous exit stays quiet", async () => {
    const { dir, lines, logger } = await setup();
    await writeFile(join(dir, "daemon-exit.json"), JSON.stringify({ state: "exited", pid: 4242, startedAt: 1_000, endedAt: 2_000, exitCode: 0 }));
    claimBootMarker(dir, logger);
    expect(lines).toEqual([]);
});
