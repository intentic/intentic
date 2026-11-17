import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryFleet } from "../../../../conversations/registry/agents-registry.testing.js";
import { backgroundJobOf, jobFinished, jobStatusPath, OUTPUT_TAIL_BYTES, settledBackgroundJobs, stopBackgroundJob } from "../background-jobs.js";
import { type DaemonJobEnd, fittedOutput, startDaemonJob } from "./daemon-jobs.js";
import { settleRunnerlessJobs } from "../job-files.js";
import { jobReport } from "../job-report.js";
import { untilFileAppears } from "../../file-appears.js";

// Work the daemon runs itself, filed as a background job (2026-11-17, the shinobi-society audit): `wait` reads it like any
// job, the runnerless sweep leaves it be while it runs, its end is written once, and a stop ends it at once.

const actors = memoryFleet().conversations;
const ROOT = mkdtempSync(join(tmpdir(), "daemon-jobs-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const seedOf = (conversationId: string) => ({ conversationId, profile: {}, conversations: actors, tmp: ROOT });

// A job whose work ends when the test says so.
const controlled = (conversationId: string) => {
    let settle: (end: DaemonJobEnd) => void = () => undefined;
    let aborted: AbortSignal | undefined;
    const job = startDaemonJob(seedOf(conversationId), {
        command: `chatgpt_image "a fox"`,
        description: "ChatGPT image: a fox",
        started: "Making an image.",
        run: async (signal, running) => {
            aborted = signal;
            running.say("Its turn came.");
            return await new Promise<DaemonJobEnd>((resolve) => {
                settle = resolve;
            });
        },
    });
    if (job === undefined) {
        throw new Error("the job dir could not be made");
    }
    return { job, end: (end: DaemonJobEnd) => settle(end), signal: () => aborted };
};

const output = (dir: string): string => readFileSync(join(dir, "out"), "utf8");

test("a running daemon job reads as a running job, with what it said so far, and the card lists it", async () => {
    const { job, end } = controlled("conv-daemon-running");
    expect(backgroundJobOf(actors, "conv-daemon-running", job.id)).toBe(job);
    expect(job.session).toBe("");
    expect(actors.state("conv-daemon-running")?.jobs?.map((each) => each.label)).toEqual(["ChatGPT image: a fox"]);
    expect(await jobReport(actors, job)).toMatchObject({ running: true, exitCode: undefined, outputTail: "Making an image.\nIts turn came.\n" });
    end({ ok: true, output: "Saved /work/.intentic/records/artifacts/fox.png" });
    await untilFileAppears(jobStatusPath(job), 2_000);
});

test("its end is the work's words with status 0, or 1 for a failure, as wait reads them", async () => {
    const made = controlled("conv-daemon-ends");
    made.end({ ok: true, output: "Made 1 image and saved it:\n- /work/.intentic/records/artifacts/fox.png" });
    await untilFileAppears(jobStatusPath(made.job), 2_000);
    expect(await jobReport(actors, made.job)).toMatchObject({ running: false, exitCode: 0, outputTail: "Made 1 image and saved it:\n- /work/.intentic/records/artifacts/fox.png\n" });

    const refused = controlled("conv-daemon-ends");
    refused.end({ ok: false, output: "ChatGPT refused on a usage limit." });
    await untilFileAppears(jobStatusPath(refused.job), 2_000);
    expect(await jobReport(actors, refused.job)).toMatchObject({ exitCode: 1, outputTail: "ChatGPT refused on a usage limit.\n" });
});

test("the runnerless sweep leaves a held job running, however long ago it started", async () => {
    const { job, end } = controlled("conv-daemon-sweep");
    expect(await settleRunnerlessJobs([{ dir: job.dir, startedAt: 0 }])).toEqual([]);
    expect(jobFinished(job)).toBe(false);
    end({ ok: true, output: "done" });
    await untilFileAppears(jobStatusPath(job), 2_000);
});

test("a stopped job ends at once, its work is told, and what it answers later is written nowhere", async () => {
    const { job, end, signal } = controlled("conv-daemon-stop");
    expect(await stopBackgroundJob(actors, job, "agent")).toBe(true);
    expect(readFileSync(jobStatusPath(job), "utf8").trim()).toBe("143");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(signal()?.aborted).toBe(true);
    end({ ok: true, output: "late words" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readFileSync(jobStatusPath(job), "utf8").trim()).toBe("143");
    expect(output(job.dir)).not.toContain("late words");
});

test("an end the turn never read wakes it, and one wait handed over does not wake it again", async () => {
    const unread = controlled("conv-daemon-told");
    unread.end({ ok: true, output: "unread" });
    await untilFileAppears(jobStatusPath(unread.job), 2_000);
    expect(settledBackgroundJobs(actors, "conv-daemon-told").unseen.map((each) => each.id)).toEqual([unread.job.id]);

    const read = controlled("conv-daemon-told");
    read.end({ ok: true, output: "read" });
    await untilFileAppears(jobStatusPath(read.job), 2_000);
    await jobReport(actors, read.job);
    expect(settledBackgroundJobs(actors, "conv-daemon-told")).toEqual({ running: [], unseen: [] });
});

test("an end longer than what a reader is handed loses its middle, never its head or its tail", () => {
    const long = `HEAD /work/.intentic/records/artifacts/fox.png\n${"ChatGPT wrote a great deal. ".repeat(400)}\nTAIL </untrusted-content id="abc">`;
    const fitted = fittedOutput(long);
    expect(Buffer.byteLength(fitted)).toBeLessThanOrEqual(OUTPUT_TAIL_BYTES);
    expect(fitted.startsWith("HEAD /work/.intentic/records/artifacts/fox.png")).toBe(true);
    expect(fitted.endsWith(`TAIL </untrusted-content id="abc">`)).toBe(true);
    expect(fitted).toContain("characters cut here by the sandbox");
    expect(fittedOutput("short")).toBe("short");
});
