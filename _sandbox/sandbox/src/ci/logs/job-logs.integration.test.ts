import { mkdtempSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubEnv } from "@intentic/testing/bun";
import { unstubbed } from "@intentic/testing";
import type { Logger } from "pino";
import { ciFailureEvidence } from "../ci-fix.js";
import type { CiProject } from "../projects.js";
import type { FetchFn } from "../providers.js";
import { ciLogsRoot, jobLogPath, keepJobLog, keptJobLog } from "./job-logs.js";

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

// A finished job's log never changes, so a second read of the same run takes the one kept by the first.
test("a kept log is read back whole; a refusal note or a missing file reads as nothing kept", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-logs-"));
    const job = { repo: "web", runId: 51, jobId: 510, name: "verify" };
    expect(await keptJobLog(root, job)).toBeUndefined();
    await keepJobLog(root, job, "FAIL src/a.test.ts > adds");
    expect(await keptJobLog(root, job)).toBe("FAIL src/a.test.ts > adds");
    await keepJobLog(root, job, "(log unavailable: 404)");
    expect(await keptJobLog(root, job)).toBeUndefined();
});

// The press this exists for: main's fixer had read run 61's log and kept it, then handed the failure back, and the
// owner's Fix downloaded the same 4 MB again before any agent existed.
test("a Fix's evidence reads a log an earlier read kept, and asks the forge only for the job list", async () => {
    stubEnv("TMPDIR", mkdtempSync(join(tmpdir(), "ci-tmp-")));
    await keepJobLog(ciLogsRoot(), { repo: "web", runId: 61, jobId: 610, name: "verify" }, "FAIL src/kept.test.ts > adds");
    const asked: string[] = [];
    const fetchFn: FetchFn = async (url) => {
        asked.push(url instanceof Request ? url.url : String(url));
        return new Response(JSON.stringify({ jobs: [{ id: 610, name: "verify", status: "completed", conclusion: "failure", steps: [] }] }));
    };
    const project = unstubbed<CiProject>("project", {
        repo: "web",
        project: "acme/web",
        account: unstubbed<CiProject["account"]>("account", { provider: "github", apiBase: "https://api.github.test", token: "T" }),
    });
    const logger = unstubbed<Logger>("logger", { warn: () => {} });
    const evidence = await ciFailureEvidence(project, 61, logger, fetchFn);
    expect(evidence.logs).toContain("src/kept.test.ts");
    expect(asked.filter((url) => url.includes("/logs"))).toEqual([]);
});
