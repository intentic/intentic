import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountUsage } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { createBurnRates } from "./burn-rates.js";
import { fileReadingsLog } from "./readings-log.js";

const RESET = 1_792_522_800;
const T0 = Date.parse("2026-10-20T15:37:00Z");
const MIN = 60_000;

const reading = (fiveHour: number, weekly: number, minute: number): AccountUsage => ({
    windows: [
        { kind: "five_hour", utilization: fiveHour, resetsAt: RESET, gates: "all" },
        { kind: "seven_day", utilization: weekly, resetsAt: RESET + 3 * 86_400, gates: "all" },
    ],
    measuredAt: T0 + minute * MIN,
});

describe("what the sandbox learns of how fast its agents spend", () => {
    it("learns each window's cost per point from the meter, keeps it across a restart, and logs only readings that moved", async () => {
        const dir = mkdtempSync(join(tmpdir(), "burn-rates-"));
        const log = fileReadingsLog(join(dir, "usage-readings.jsonl"));
        // 1.5M metered a minute on radarsu.
        const metered = (provider: string, account: string, from: number, to: number): number =>
            provider === "claude" && account === "radarsu" ? ((to - from) / MIN) * 1_500_000 : 0;
        const path = join(dir, "burn-rates.json");
        const rates = createBurnRates({ path, log, metered, now: () => T0 + 70 * MIN });
        await rates.reading("claude", "radarsu", reading(16, 55, 0));
        await rates.reading("claude", "radarsu", reading(16, 55, 1));
        await rates.reading("claude", "radarsu", reading(100, 64, 62));
        // 93M over 84 five-hour points and 9 weekly ones.
        expect(rates.tokensPerPoint("claude", "radarsu", "five_hour")).toBeCloseTo(93_000_000 / 84);
        expect(rates.tokensPerPoint("claude", "radarsu", "seven_day")).toBeCloseTo(93_000_000 / 9);
        expect(rates.tokensPerPoint("claude", "artur", "five_hour")).toBeUndefined();
        expect(readFileSync(join(dir, "usage-readings.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);

        await rates.turnEnded({ provider: "claude", model: "claude-opus-5-5", startedAt: T0, endedAt: T0 + 60 * MIN, weighted: 9_000_000, child: true });
        // A short turn says how long a child ran, not a pace.
        await rates.turnEnded({ provider: "claude", model: "claude-opus-5-5", startedAt: T0, endedAt: T0 + 2 * MIN, weighted: 9_000_000, child: true });
        expect(rates.modelPace("claude", "claude-opus-5-5")?.tokensPerHour).toBeCloseTo(9_000_000);

        const again = createBurnRates({ path, log, metered });
        await again.ready();
        expect(again.tokensPerPoint("claude", "radarsu", "five_hour")).toBeCloseTo(93_000_000 / 84);
        // An hour, then two minutes: 1 × 0.7 + (2 / 60) × 0.3.
        expect(again.modelPace("claude", "claude-opus-5-5")?.childHours).toBeCloseTo(0.71, 2);
    });
});
