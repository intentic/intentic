import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { sleep } from "@intentic/base/async";
import { WORKLOAD_ENV } from "../../seams/workload-stamp.js";
import { createLiveMetrics } from "./live-metrics.js";

// Reads this machine's real procfs, which only Linux has.
test.skipIf(process.platform !== "linux")("a process stamped with a conversation is found under it, with the memory and CPU it uses", async () => {
    const owner = `metrics-probe-${process.pid}`;
    // Spins for its whole life, so the second reading has CPU to find however loaded the machine running this is.
    const child = spawn(process.execPath, ["-e", "const end = Date.now() + 30000; while (Date.now() < end) {}"], {
        env: { ...process.env, [WORKLOAD_ENV]: owner },
        stdio: "ignore",
    });
    try {
        await once(child, "spawn");
        const live = createLiveMetrics({ workspaceRoot: tmpdir() });
        const first = await live.read();
        expect(first.sessions[owner]?.processes).toBe(1);
        expect(first.sessions[owner]?.cpuPercent).toBeUndefined();

        await sleep(1_500);
        const second = await live.read();
        expect(second.windowMs).toBeGreaterThanOrEqual(1_500);
        expect(second.sessions[owner]?.cpuPercent).toBeGreaterThan(0);
        expect(second.sessions[owner]?.rssBytes).toBeGreaterThan(0);
        expect(second.sandbox.processes).toBeGreaterThan(1);
    } finally {
        child.kill("SIGKILL");
    }
});
