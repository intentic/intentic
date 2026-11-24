import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountUsage } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { fileReadingsLog, type ReadingLine } from "./readings-log.js";

// The readings log is cut back to its newest lines past its cap, and a cut has to leave it under the cap: one that left
// it over was made again by the next reading, a whole-file rewrite per line (2026-11-24: 20,000 kept lines were 5.1 MB
// against a 4 MB cap, rewritten 14-20 times a minute on rog). Lines here are the size a routed account's reading is.

const RESET = 1_795_601_515;

// What a routed Gemini account's reading looks like on disk, about 255 bytes.
const storedLine = (index: number): ReadingLine => ({
    at: 1_794_996_717_325 + index,
    provider: "gemini",
    account: `gemini:antigravity-account-${index % 32}@example.com.json`,
    windows: [
        { kind: "google:3p-weekly", utilization: index % 100, resetsAt: RESET },
        { kind: "google:models:gemini", utilization: index % 100, resetsAt: RESET },
    ],
});

const usage = (utilization: number, measuredAt: number): AccountUsage => ({
    windows: [{ kind: "five_hour", utilization, resetsAt: RESET, gates: "all" }],
    measuredAt,
});

let dir = "";

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "readings-log-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

test("past its cap the log is cut once to the newest 3 MB, and the readings after it are appended, not rewritten", async () => {
    const path = join(dir, "usage-readings.jsonl");
    const full = Array.from({ length: 20_000 }, (_, index) => `${JSON.stringify(storedLine(index))}\n`).join("");
    writeFileSync(path, full);
    expect(full.length).toBeGreaterThan(4_000_000);
    const log = fileReadingsLog(path);

    expect(await log.append("claude", "radarsu", usage(10, 1))).toBe(true);
    const cut = statSync(path);
    expect(cut.size).toBeLessThanOrEqual(3_000_000 + 200);
    const kept = await log.read();
    expect(kept.at(-1)).toMatchObject({ provider: "claude", account: "radarsu", at: 1 });
    // The newest stored line survived the cut, the oldest did not.
    expect(kept.at(-2)?.at).toBe(storedLine(19_999).at);
    expect(kept[0]?.at).toBeGreaterThan(storedLine(0).at);

    // A hundred readings later the file is the one the cut left, grown by a hundred lines: none of them rewrote it.
    for (let minute = 2; minute < 102; minute += 1) {
        expect(await log.append("claude", "radarsu", usage(10 + minute, minute))).toBe(true);
    }
    const after = statSync(path);
    expect(after.ino).toBe(cut.ino);
    expect((await log.read()).length).toBe(kept.length + 100);
});
