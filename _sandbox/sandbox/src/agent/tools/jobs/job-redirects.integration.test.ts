import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryFleet } from "../../../conversations/registry/agents-registry.testing.js";
import type { BackgroundJob } from "./background-jobs.js";
import { redirectedOutput } from "./job-redirects.js";
import { jobReport } from "./job-report.js";

// 2026-11-17, the shinobi-society audit: `cmd > /tmp/x.log 2>&1` as a job left its capture empty, and `wait` said
// `"outputTail":""` and quiet for 7152 s while the log grew, so the agent polled it with tail a dozen times.

const ROOT = mkdtempSync(join(tmpdir(), "job-redirects-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const actors = memoryFleet().conversations;

// A /proc as the kernel lays it out for what this reads: argv, stat (pid, comm, state, ppid, pgrp, session), and fds as
// links to what they are open on.
const proc = (name: string) => {
    const root = join(ROOT, name, "proc");
    const add = (pid: number, argv: string, session: number, fds: Record<number, string>): void => {
        const dir = join(root, String(pid));
        mkdirSync(join(dir, "fd"), { recursive: true });
        writeFileSync(join(dir, "cmdline"), argv);
        writeFileSync(join(dir, "stat"), `${String(pid)} (x) S 1 ${String(pid)} ${String(session)} 0 -1`);
        for (const [fd, target] of Object.entries(fds)) {
            symlinkSync(target, join(dir, "fd", fd));
        }
    };
    return { root, add };
};

const jobIn = (name: string, startedAt: number): BackgroundJob => {
    const dir = join(ROOT, name, "intentic-run-job-x");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cmd"), "cargo build > log 2>&1\n");
    writeFileSync(join(dir, "out"), "");
    utimesSync(join(dir, "out"), startedAt / 1000, startedAt / 1000);
    return { id: `job-${name}`, conversationId: "conv-redirect", command: "cargo build > /tmp/b.log 2>&1", label: "cargo build", dir, session: "s", startedAt, profile: {} };
};

describe("a job whose output goes to a file of its own", () => {
    it("is read from that file, with its quiet measured from that file, and the file named", async () => {
        const now = Date.now();
        const job = jobIn("busy", now - 7_200_000);
        const log = join(ROOT, "busy", "build.log");
        writeFileSync(log, "   Compiling integra-kernel v0.1.0\n");
        utimesSync(log, (now - 3_000) / 1000, (now - 3_000) / 1000);
        const { root, add } = proc("busy");
        add(100, `bash\0${join(job.dir, "runner")}\0`, 100, { 1: "/dev/pts/3", 2: "/dev/pts/3" });
        add(101, "tee\0out\0", 100, { 1: "/dev/pts/3", 3: join(job.dir, "out") });
        add(102, "cargo\0build\0", 100, { 1: log, 2: log });
        // Another session's process writing a file is not this job's.
        add(200, "cargo\0test\0", 200, { 1: join(ROOT, "busy", "other.log") });
        writeFileSync(join(ROOT, "busy", "other.log"), "elsewhere\n");

        expect(await redirectedOutput(job.dir, root)).toEqual({ path: log, mtimeMs: expect.any(Number) });
        expect(await jobReport(actors, job, now, root)).toEqual({
            id: job.id,
            command: "cargo build > /tmp/b.log 2>&1",
            exitCode: undefined,
            running: true,
            outputTail: "   Compiling integra-kernel v0.1.0\n",
            outputFile: join(job.dir, "out"),
            outputTailFrom: log,
            quietForSeconds: 3,
        });
    });

    it("stays on the capture when nothing of the job writes to a file", async () => {
        const now = Date.now();
        const job = jobIn("pane", now - 60_000);
        const { root, add } = proc("pane");
        add(100, `bash\0${join(job.dir, "runner")}\0`, 100, { 1: "/dev/pts/3" });
        add(101, "sleep\0", 100, { 1: "/dev/null", 2: "pipe:[123]" });
        expect(await redirectedOutput(job.dir, root)).toBeUndefined();
        expect(await jobReport(actors, job, now, root)).toMatchObject({ outputTail: "", quietForSeconds: 60 });
        expect(Object.keys(await jobReport(actors, job, now, root))).not.toContain("outputTailFrom");
    });

    it("finds nothing once the job's runner is gone", async () => {
        const job = jobIn("gone", Date.now());
        const { root } = proc("gone");
        mkdirSync(root, { recursive: true });
        expect(await redirectedOutput(job.dir, root)).toBeUndefined();
    });
});
