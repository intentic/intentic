import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDeviceLogs } from "./logs.js";

test("the listing holds the agent's records that exist and ic's, newest first, and nothing else", async () => {
    const home = mkdtempSync(join(tmpdir(), "device-logs-"));
    const agent = join(home, "machine.log");
    writeFileSync(agent, "[t] serving 1 linked sandbox\n");
    const ic = join(home, "logs");
    mkdirSync(join(ic, "not-a-file"), { recursive: true });
    writeFileSync(join(ic, "connect-1.log"), "old");
    writeFileSync(join(ic, "recreate-dev-2.log"), "new");
    utimesSync(join(ic, "connect-1.log"), new Date("2026-10-01"), new Date("2026-10-01"));
    const logs = await listDeviceLogs({
        ic,
        agent: [
            { path: agent, kind: "agent" },
            { path: `${agent}.1`, kind: "agent" },
        ],
    });
    expect(logs.map((log) => [log.name, log.kind])).toEqual([
        ["machine.log", "agent"],
        ["ic/recreate-dev-2.log", "ic"],
        ["ic/connect-1.log", "ic"],
    ]);
    expect(logs[0]?.size).toBe(29);
});
