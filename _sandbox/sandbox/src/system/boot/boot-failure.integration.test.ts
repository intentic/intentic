import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DisposableStore } from "@intentic/base/lifecycle";
import type { BootProgress } from "@intentic/sandbox-contract";
import { pino } from "pino";
import { z } from "zod";
import { version } from "../../version.js";
import { type BootAttempt, type BootFailure, bootFailureDocument, clearBootFailure, describeBootError, failBoot } from "./boot-failure.js";

// A boot that fails before its gate opens leaves the host a record of why, stops what it had started and exits
// non-zero; the next boot that gets all the way removes the record. Each case stands the record up on a temp volume.

class Exited extends Error {
    constructor(readonly code: number) {
        super(`exited ${String(code)}`);
    }
}
// Stands in for process.exit, which a test must not reach: throws, so nothing after the exit runs either.
const exit = (code: number): never => {
    throw new Exited(code);
};

const historyRoot = (): string => mkdtempSync(join(tmpdir(), "boot-failure-"));
// Read back through the document's own schema, as a reader of the record would: a shape it does not fit fails here.
const recordIn = (root: string): BootFailure =>
    bootFailureDocument.schema.parse(JSON.parse(readFileSync(join(root, bootFailureDocument.path), "utf8")));
const LogLine = z.looseObject({ level: z.number(), msg: z.string() });
const lines: z.infer<typeof LogLine>[] = [];
const logger = pino({ level: "fatal", base: null, timestamp: false }, { write: (line: string) => void lines.push(LogLine.parse(JSON.parse(line))) });
const quiet = { warn: () => undefined };

beforeEach(() => {
    lines.length = 0;
});

// The tracker of a boot chain whose named step failed.
const failedAt = (label: string) => ({
    boot: {
        progress: (): BootProgress => ({
            ready: false,
            startedAt: 1,
            steps: [
                { key: "one", label: "Setting up the workspace", state: "done" },
                { key: "two", label, state: "failed" },
            ],
        }),
    },
});

test("a failure in the boot chain is recorded with the step it failed in, what had started is stopped, and the exit is non-zero", async () => {
    const root = historyRoot();
    const stopped: string[] = [];
    const shutdown = new DisposableStore();
    shutdown.push(() => void stopped.push("everything"));
    const attempt: BootAttempt = {
        stage: "Running the boot chain",
        historyRoot: root,
        logger,
        role: { container: true },
        services: failedAt("Opening the conversations"),
        shutdown,
    };
    const error = new Error("conversations.db is locked");

    await expect(failBoot(attempt, error, exit)).rejects.toThrow(new Exited(1));

    expect(recordIn(root)).toEqual({ at: expect.any(Number), version, error: describeBootError(error), step: "Opening the conversations" });
    expect(stopped).toEqual(["everything"]);
    expect(lines).toEqual([
        expect.objectContaining({ level: 60, step: "Opening the conversations", msg: expect.stringContaining("failed before the daemon was ready") }),
    ]);
});

test("a stop that fails cannot keep the daemon from exiting, and is named in the log", async () => {
    const root = historyRoot();
    const shutdown = new DisposableStore();
    shutdown.push(() => {
        throw new Error("socket already closed");
    });
    const attempt: BootAttempt = { stage: "Opening the netd door", historyRoot: root, logger, role: { container: true }, shutdown };

    await expect(failBoot(attempt, new Error("no netd"), exit)).rejects.toThrow(new Exited(1));

    expect(lines.map((line) => line.msg)).toContain("boot: one or more subsystems did not stop cleanly after the boot failed");
});

test("before the boot chain, the stage boot had reached names where it failed", async () => {
    const root = historyRoot();
    await expect(failBoot({ stage: "Converging the stored files", historyRoot: root, logger }, new Error("disk full"), exit)).rejects.toThrow(
        new Exited(1),
    );
    expect(recordIn(root)).toMatchObject({ step: "Converging the stored files", error: expect.stringMatching(/^Error: disk full\n/) });
});

test("a second daemon sharing the volume records nothing: the host did not start it", async () => {
    const root = historyRoot();
    await expect(
        failBoot({ stage: "Building the services", historyRoot: root, logger, role: { container: false } }, new Error("no"), exit),
    ).rejects.toThrow(new Exited(1));
    expect(() => readFileSync(join(root, bootFailureDocument.path))).toThrow("ENOENT");
});

test("a volume that cannot take the record still exits, and says so", async () => {
    const missing = join(historyRoot(), "no-such-volume");
    await expect(failBoot({ stage: "Claiming the container", historyRoot: missing, logger }, new Error("no"), exit)).rejects.toThrow(new Exited(1));
    expect(lines.map((line) => line.msg)).toEqual([
        "boot: failed before the daemon was ready; exiting so it is started again",
        "boot: the failure could not be recorded on the history volume",
    ]);
});

test("the error is its message and the first stack lines, not the whole stack", () => {
    const error = new Error("boom");
    error.stack = ["Error: boom", ...Array.from({ length: 20 }, (_, index) => `    at frame${String(index)} (file.js:1:1)`)].join("\n");
    expect(describeBootError(error).split("\n")).toEqual([
        "Error: boom",
        ...Array.from({ length: 6 }, (_, index) => `    at frame${String(index)} (file.js:1:1)`),
    ]);
});

test("a boot that gets all the way removes the last one's record, and finding none is no failure", async () => {
    const root = historyRoot();
    writeFileSync(join(root, bootFailureDocument.path), "{}");
    await clearBootFailure(root, quiet);
    expect(() => readFileSync(join(root, bootFailureDocument.path))).toThrow("ENOENT");
    await clearBootFailure(root, quiet);
});
