import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Logger, pino } from "pino";
import { claimBootMarker as claim, previousRun, previousRunDied, resetStopNoted, writeRestartIntent } from "./boot-marker.js";
import { announceStop } from "./daemon-stop.js";
import { RESTART_INTENT_FILE, type RestartRecord, RESTARTS_FILE } from "./restart-record.js";
import { processIdentity, type ProcessIdentity } from "../../resources/proc-stat.js";

const setup = async (): Promise<{ dir: string; lines: Record<string, unknown>[]; logger: Logger }> => {
    const dir = await mkdtemp(join(tmpdir(), "boot-marker-"));
    const lines: Record<string, unknown>[] = [];
    // SAFETY: pino writes one JSON object per line.
    const logger = pino({ level: "debug", messageKey: "message" }, { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) });
    return { dir, lines, logger };
};

// Every claim keeps its /tmp marker inside its own directory, never the machine's.
const claimBootMarker = (dir: string, logger: Logger, now?: number): ReturnType<typeof claim> => {
    const tmpMarker = join(dir, "tmp-marker");
    return claim(dir, logger, now === undefined ? { tmpMarker } : { tmpMarker, now });
};

const restarts = async (dir: string): Promise<RestartRecord[]> =>
    (await readFile(join(dir, RESTARTS_FILE), "utf8"))
        .trim()
        .split("\n")
        // SAFETY: appendRestart writes one RestartRecord per line.
        .map((line) => JSON.parse(line) as RestartRecord);

const messageOf = (line: Record<string, unknown> | undefined): string => String(line?.["message"]);

afterEach(() => resetStopNoted());

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

test("a first boot says so in one info line, claims the marker, and an exit outside the stop is not graceful", async () => {
    const { dir, lines, logger } = await setup();
    const marker = claimBootMarker(dir, logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 30, previous: { ended: "unknown", graceful: false }, build: { version: expect.any(String) } });
    expect(messageOf(lines[0])).toMatch(/^daemon .* starting; previous run ended: unknown/u);
    expect(JSON.parse(await readFile(join(dir, "daemon-exit.json"), "utf8"))).toMatchObject({ state: "running", ...self(), version: expect.any(String) });

    marker.markExited(0);
    expect(JSON.parse(await readFile(join(dir, "daemon-exit.json"), "utf8"))).toMatchObject({ state: "exited", exitCode: 0, graceful: false });
});

test("a stop is recorded with its signal and initiator, and the next boot files it and spends the intent", async () => {
    const { dir, lines, logger } = await setup();
    const start = Date.now();
    const marker = claimBootMarker(dir, logger, start);
    writeRestartIntent(dir, { by: "ic", host: "rog", side: "wsl", action: "update", reason: "a newer image" });
    announceStop(logger, dir, 0, { signal: "SIGTERM" });
    expect(lines.at(-1)).toMatchObject({ level: 30, signal: "SIGTERM", initiator: { by: "ic", action: "update" }, exitCode: 0 });
    expect(messageOf(lines.at(-1))).toContain("shutting down intentic sandbox daemon… (SIGTERM, ic on rog (wsl) asked to update: a newer image");
    marker.markExited(0);
    expect(JSON.parse(await readFile(join(dir, "daemon-exit.json"), "utf8"))).toMatchObject({ state: "exited", graceful: true, signal: "SIGTERM", stopReason: expect.stringContaining("asked to update") });

    lines.length = 0;
    claimBootMarker(dir, logger, start + 60_000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 30, previous: { ended: "stopped", graceful: true, signal: "SIGTERM", intent: { by: "ic", action: "update" } } });
    expect(messageOf(lines[0])).toContain("previous run ended: stopped gracefully on SIGTERM");
    expect(previousRun()).toMatchObject({ ended: "stopped", tmpCleared: false });
    const filed = await restarts(dir);
    expect(filed).toHaveLength(2);
    expect(filed[1]).toMatchObject({ boot: { pid: process.pid }, previous: { ended: "stopped", intent: { reason: "a newer image" } } });
    expect(existsSync(join(dir, RESTART_INTENT_FILE))).toBe(false);
});

test("a daemon that stops for a reason of its own writes it as the restart intent", async () => {
    const { dir, lines, logger } = await setup();
    claimBootMarker(dir, logger);
    announceStop(logger, dir, 75, undefined);
    expect(lines.at(-1)).toMatchObject({ initiator: { by: "daemon", action: "restart", reason: expect.stringContaining("control link") }, exitCode: 75 });
    expect(JSON.parse(await readFile(join(dir, RESTART_INTENT_FILE), "utf8"))).toMatchObject({ by: "daemon", action: "restart" });
});

test("a SIGTERM with no intent says nobody recorded who sent it", async () => {
    const { dir, lines, logger } = await setup();
    claimBootMarker(dir, logger);
    announceStop(logger, dir, 0, { signal: "SIGTERM" });
    expect(lines.at(-1)).not.toHaveProperty("initiator");
    expect(messageOf(lines.at(-1))).toContain("(SIGTERM, no initiator recorded;");
});

test("an emptied /tmp is noticed at the next boot", async () => {
    const { dir, lines, logger } = await setup();
    claimBootMarker(dir, logger).markExited(0);
    rmSync(join(dir, "tmp-marker"));
    lines.length = 0;
    claimBootMarker(dir, logger);
    expect(lines[0]).toMatchObject({ previous: { tmpCleared: true, containerRestarted: false } });
    expect(messageOf(lines[0])).toContain("/tmp was emptied");
});

test("a marker still saying running is reported as an unannounced death", async () => {
    const { dir, lines, logger } = await setup();
    const died = deadPid();
    await writeFile(join(dir, "daemon-exit.json"), JSON.stringify({ state: "running", pid: died, startTimeTicks: 1, startedAt: 1_000 }));
    claimBootMarker(dir, logger);
    // What checks the conversation database before anything reads it (store/conversations-db-recovery.ts).
    expect(previousRunDied()).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 50, diedPid: died, previous: { ended: "killed", graceful: false } });
    expect(messageOf(lines[0])).toContain("previous run ended: was killed without warning");
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

test("a clean previous exit from before `graceful` reads as a stop, in one info line", async () => {
    const { dir, lines, logger } = await setup();
    await writeFile(
        join(dir, "daemon-exit.json"),
        JSON.stringify({ state: "exited", pid: 4242, startTimeTicks: 1, startedAt: 1_000, endedAt: 2_000, exitCode: 0 }),
    );
    claimBootMarker(dir, logger);
    expect(previousRunDied()).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 30, previous: { ended: "stopped", graceful: true, uptimeSeconds: 1 } });
    expect(lines[0]).not.toHaveProperty("diedPid");
});

test("a death an initiator announced first is a warning naming it, not an unexplained kill", async () => {
    const { dir, lines, logger } = await setup();
    const startedAt = Date.now() - 60_000;
    await writeFile(join(dir, "daemon-exit.json"), JSON.stringify({ state: "running", pid: deadPid(), startTimeTicks: 1, startedAt }));
    writeRestartIntent(dir, { by: "keeper", action: "recreate", reason: "health failed", checks: ["health"] });
    claimBootMarker(dir, logger);
    expect(lines[0]).toMatchObject({ level: 40, previous: { ended: "killed", intent: { by: "keeper", checks: ["health"] } } });
    expect(messageOf(lines[0])).toContain("keeper asked to recreate: health failed [failed checks: health]");
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
