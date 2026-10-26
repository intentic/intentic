import { unstubbed } from "@intentic/testing";
import { pino } from "pino";
import { closeIdleBrowsers, type ReaperBrowsers } from "./browser-reaper.js";

test("pressure shortens only the idle window and keeps a configured shorter grace", async () => {
    const windows: number[] = [];
    const closed: string[] = [];
    const browsers = unstubbed<ReaperBrowsers>("browsers", {
        idleNames: (_now, ms) => { windows.push(ms); return ms <= 120_000 ? ["idle"] : []; },
        close: async (name) => { closed.push(name); },
    });
    const logger = pino({ level: "silent" });
    await closeIdleBrowsers(browsers, 1_000_000, 600_000, async () => false, logger);
    expect(closed).toEqual([]);
    await closeIdleBrowsers(browsers, 1_000_000, 600_000, async () => true, logger);
    await closeIdleBrowsers(browsers, 1_000_000, 30_000, async () => true, logger);
    expect(windows).toEqual([600_000, 120_000, 30_000]);
    expect(closed).toEqual(["idle", "idle"]);
});
