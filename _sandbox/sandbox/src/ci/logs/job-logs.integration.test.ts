import { mkdtempSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobLogPath, keepJobLog } from "./job-logs.js";

// A failed job's whole log is kept where its fix agent can read it, under a name a person reads, and a repository keeps
// only its newest runs' logs.

test("keeps a job's whole log under the run, named for the job, and keeps nothing for an empty log", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-logs-"));
    const log = `${"(pass) x\n".repeat(1000)}FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n`;
    const path = await keepJobLog(root, { repo: "acme/web", runId: 41, jobId: 410, name: "verify-clocks (Pacific/Niue)" }, log);
    expect(path).toBe(join(root, "acme-web", "41", "410-verify-clocks-Pacific-Niue.log"));
    expect(path).toBe(jobLogPath(root, "acme/web", 41, 410, "verify-clocks (Pacific/Niue)"));
    expect(readFileSync(path ?? "", "utf8")).toBe(log);
    expect(await keepJobLog(root, { repo: "acme/web", runId: 42, jobId: 420, name: "lint" }, "")).toBeUndefined();
});

test("a repository keeps its newest twelve runs' logs and drops the rest", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-logs-"));
    for (let run = 1; run <= 14; run += 1) {
        await keepJobLog(root, { repo: "web", runId: run, jobId: run * 10, name: "verify" }, `run ${run}`);
        // Each run older than the next, whatever the clock's resolution.
        const at = new Date(Date.UTC(2026, 9, 1, 0, run));
        utimesSync(join(root, "web", String(run)), at, at);
    }
    await keepJobLog(root, { repo: "web", runId: 15, jobId: 150, name: "verify" }, "run 15");
    const kept = readdirSync(join(root, "web"))
        .map(Number)
        .toSorted((a, b) => a - b);
    expect(kept).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
});
