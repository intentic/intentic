import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRestart } from "./boot-marker.js";
import {
    describePreviousRun,
    type EndedRun,
    INTENT_STANDS_MS,
    previousRunOf,
    type ReadIntent,
    readRestartIntent,
    restartCost,
    RESTART_INTENT_FILE,
    RESTARTS_FILE,
    spanOf,
    standingIntent,
} from "./restart-record.js";

/* How a boot reads the run before it: the marker it left, and the intent whoever stopped it wrote first. */

const STARTED = 1_790_000_000_000;
const NOW = STARTED + 4 * 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const run = (fields: Partial<EndedRun> = {}): EndedRun => ({ state: "exited", pid: 55, startedAt: STARTED, ...fields });
const intent = (at: number, fields: Partial<ReadIntent> = {}): ReadIntent => ({ at: iso(at), by: "ic", action: "update", reason: "a newer image", ...fields });

test("a run that went through the stop is graceful, with its signal and uptime", () => {
    const previous = previousRunOf({ marker: run({ endedAt: STARTED + 3_725_000, exitCode: 0, graceful: true, signal: "SIGTERM" }), intent: undefined, now: NOW });
    expect(previous).toEqual({
        ended: "stopped",
        graceful: true,
        pid: 55,
        startedAt: iso(STARTED),
        stoppedAt: iso(STARTED + 3_725_000),
        uptimeSeconds: 3725,
        signal: "SIGTERM",
        exitCode: 0,
    });
    expect(describePreviousRun(previous)).toBe(
        "stopped gracefully on SIGTERM after 1h 2m; nothing recorded who sent it (docker stop, a host shutdown, or a tool that writes no restart-intent.json)",
    );
});

test("each way a run can end is told apart", () => {
    const ended = (marker: EndedRun | undefined, fatalReports: string[] = []): string => previousRunOf({ marker, intent: undefined, now: NOW, fatalReports }).ended;
    expect(ended(run({ exitCode: 0, graceful: false }))).toBe("exited");
    expect(ended(run({ exitCode: 1, graceful: false }))).toBe("crashed");
    // A marker from before `graceful` existed: exit 0 came through the stop, anything else did not.
    expect(ended(run({ exitCode: 0 }))).toBe("stopped");
    expect(ended(run({ exitCode: 75 }))).toBe("crashed");
    expect(ended(run({ state: "running" }))).toBe("killed");
    expect(ended(run({ state: "running" }), ["report.1.55.0.json"])).toBe("crashed");
    expect(ended(undefined)).toBe("unknown");
});

test("an intent explains the stop only when written during that run and recently", () => {
    expect(standingIntent(intent(NOW - 60_000), STARTED, NOW)).toMatchObject({ by: "ic" });
    // Written before the run began: it was about an earlier stop.
    expect(standingIntent(intent(STARTED - 1), STARTED, NOW)).toBeUndefined();
    expect(standingIntent(intent(NOW - INTENT_STANDS_MS - 1), undefined, NOW)).toBeUndefined();
    expect(standingIntent(intent(NOW + 1), STARTED, NOW)).toBeUndefined();
    // With no marker to date the run, a recent intent still says who stopped it.
    expect(standingIntent(intent(NOW - 60_000), undefined, NOW)).toMatchObject({ by: "ic" });
});

test("a kill an initiator announced names it, and what the restart cost", () => {
    const previous = previousRunOf({
        marker: run({ state: "running" }),
        intent: intent(NOW - 30_000, { by: "keeper", host: "rog", side: "wsl", action: "recreate", reason: "health failed", checks: ["health"] }),
        now: NOW,
        containerRestarted: true,
        tmpCleared: true,
    });
    expect(previous).toMatchObject({ ended: "killed", graceful: false, containerRestarted: true, tmpCleared: true, intent: { by: "keeper" } });
    expect(describePreviousRun(previous)).toBe(
        "was killed without warning (SIGKILL, a kernel OOM kill, a forced container stop, netd killing a stuck daemon, or the host going down); keeper on rog (wsl) asked to recreate: health failed [failed checks: health]; the container restarted too, so every process in it ended (terminals, background jobs, dev servers) and /tmp was emptied",
    );
});

test("an intent on disk is read leniently but must carry a real time", () => {
    const dir = mkdtempSync(join(tmpdir(), "restart-intent-"));
    writeFileSync(join(dir, RESTART_INTENT_FILE), JSON.stringify({ at: iso(NOW), by: "netd", action: "kill", reason: "stuck", extra: 1 }));
    expect(readRestartIntent(dir)).toEqual({ at: iso(NOW), by: "netd", action: "kill", reason: "stuck" });
    writeFileSync(join(dir, RESTART_INTENT_FILE), JSON.stringify({ at: "yesterday", by: "ic", action: "update", reason: "x" }));
    expect(readRestartIntent(dir)).toBeUndefined();
    writeFileSync(join(dir, RESTART_INTENT_FILE), "{torn");
    expect(readRestartIntent(dir)).toBeUndefined();
});

test("restarts.jsonl keeps the newest 500 records", () => {
    const dir = mkdtempSync(join(tmpdir(), "restarts-"));
    const record = (index: number) => ({ at: iso(NOW + index), boot: { pid: index, version: "0.0.0" }, previous: { ended: "unknown" as const, graceful: false } });
    writeFileSync(join(dir, RESTARTS_FILE), `${Array.from({ length: 600 }, (_, index) => JSON.stringify(record(index))).join("\n")}\n`);
    appendRestart(dir, record(600));
    const lines = readFileSync(join(dir, RESTARTS_FILE), "utf8").trim().split("\n");
    expect(lines).toHaveLength(500);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ boot: { pid: 101 } });
    expect(JSON.parse(lines.at(-1) ?? "")).toMatchObject({ boot: { pid: 600 } });
});

test("spans read in the largest two units", () => {
    expect(spanOf(9)).toBe("9s");
    expect(spanOf(245)).toBe("4m 5s");
    expect(spanOf(11_520)).toBe("3h 12m");
});

test("a resumed turn is told what the restart cost it and why", () => {
    const cut = previousRunOf({
        marker: run({ endedAt: STARTED + 60_000, exitCode: 0, graceful: true, signal: "SIGTERM" }),
        intent: intent(STARTED + 59_000),
        now: STARTED + 120_000,
        containerRestarted: true,
        tmpCleared: false,
    });
    expect(restartCost(cut)).toBe(
        "The whole container restarted, so every process in it ended: background commands, terminal sessions and dev servers started before it are gone, and must be started again if still needed. /tmp was kept. Why: ic asked to update: a newer image.",
    );
    const killed = previousRunOf({ marker: run({ state: "running" }), intent: undefined, now: NOW, containerRestarted: false });
    expect(restartCost(killed)).toMatch(/^Only the daemon restarted, .* The run before it was killed without warning \(/u);
});
