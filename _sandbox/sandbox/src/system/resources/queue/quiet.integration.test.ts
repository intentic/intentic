import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot, repoRoot } from "@intentic/constants/node";

// The quiet lane (bin/quiet) end to end, with the real queue-run and the real launcher: it runs the command, holds the
// sandbox's gate while it runs, and prints the conditions it ran under beside the result (2026-11-19, the
// shinobi-society audit: benchmarks taken at load 30 read 47% slower than at load 7, and nothing said so).

const BIN = join(packageRoot(import.meta.url), "bin");
const LAUNCH = join(repoRoot(import.meta.url), "_tools/constants/src/heavy/heavy-launch.cjs");

interface Run {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

const quiet = (queue: string, args: readonly string[]): Promise<Run> =>
    new Promise((resolve) => {
        // `bash <path>`: bin scripts are mode 644 in git, executable only after the image's COPY.
        const child = spawn("bash", [join(BIN, "quiet"), ...args], {
            env: {
                ...process.env,
                INTENTIC_QUEUE_DIR: queue,
                INTENTIC_QUEUE_CAPTURE_DIR: "",
                INTENTIC_QUEUE_GATE: "",
                INTENTIC_HEAVY_HELD: "",
                INTENTIC_QUEUE_RUN: join(BIN, "queue-run"),
                INTENTIC_HEAVY_LAUNCH: LAUNCH,
                INTENTIC_ROOM_SOCKET: "/nonexistent/room.sock",
            },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

test("it runs the command with its own exit code, holding the gate, and says what it ran under before and after", async () => {
    const queue = await mkdtemp(join(tmpdir(), "quiet-"));
    // `--idle 0`: this suite's machine need not be calm for the lane to be tested.
    const run = await quiet(queue, ["--idle", "0", "--", "bash", "-c", "echo measured; echo \"gate=$INTENTIC_QUEUE_GATE\"; exit 3"]);
    expect(run.code).toBe(3);
    expect(run.stdout.trim().split("\n")).toEqual(["measured", "gate=exclusive"]);
    expect(run.stderr).toMatch(/\[quiet\] starting: [\d.]+ of \d+ cores busy(?: outside this sandbox \([\d.]+ in it\))?, load [\d. ]+\. New heavy commands in this sandbox wait until it ends\./u);
    expect(run.stderr).toMatch(/\[quiet\] exit 3 after [\d.]+s\. Ran under: before, .*; while it ran, everything else kept [\d.]+ cores busy \(it used [\d.]+\); after, load [\d. ]+\./u);
    // The exclusive holder wrote itself down for the commands it holds off to name.
    expect(await readFile(join(queue, ".gate", "holder"), "utf8")).toMatch(/^\d+ \d+ quiet /u);
});

test("its usage is its own header, and a command is required", async () => {
    const run = await quiet(await mkdtemp(join(tmpdir(), "quiet-")), []);
    expect(run.code).toBe(2);
    expect(run.stderr).toStartWith("quiet [--idle N] [--pin N] [--wait SECONDS] [--max-hold SECONDS] -- <command> [args...]");
});
