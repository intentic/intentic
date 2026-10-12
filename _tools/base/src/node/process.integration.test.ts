import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipText, execBounded, ProcessError, runBounded, runBoundedBytes, runBoundedSync, runBoundedSyncBytes, textCollector } from "./process.js";

// Real processes under /bin/sh: the guarantees are about process groups and pipes, which no fake can stand in for.

const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

describe("runBounded", () => {
    it("answers a command's exit code and output", async () => {
        const result = await runBounded("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"]);
        expect(result).toMatchObject({ exitCode: 3, timedOut: false, aborted: false, lingering: false });
        expect(result.stdout.text).toBe("out\n");
        expect(result.stderr.text).toBe("err\n");
    });

    it("reports a missing binary in the result rather than throwing", async () => {
        const result = await runBounded("/no/such/binary-anywhere", []);
        expect(result.exitCode).toBe(null);
        expect(result.spawnError).toMatchObject({ code: "ENOENT" });
    });

    it("kills the whole process group at the deadline, grandchildren included", async () => {
        const dir = mkdtempSync(join(tmpdir(), "process-"));
        const pidFile = join(dir, "pid");
        // The grandchild writes its pid and sleeps long; the shell waits on it.
        const started = Date.now();
        const result = await runBounded("/bin/sh", ["-c", `sleep 30 & echo $! > ${pidFile}; wait`], { timeoutMs: 300, killGraceMs: 100 });
        expect(result.timedOut).toBe(true);
        expect(Date.now() - started).toBeLessThan(10_000);
        const grandchild = Number(readFileSync(pidFile, "utf8").trim());
        expect(alive(grandchild)).toBe(false);
    });

    it("settles once the command exits even while a grandchild holds the pipe open", async () => {
        const dir = mkdtempSync(join(tmpdir(), "process-"));
        const pidFile = join(dir, "pid");
        const started = Date.now();
        // The background sleep inherits stdout and keeps it open for 30s after the shell exits.
        const result = await runBounded("/bin/sh", ["-c", `sleep 30 & echo $! > ${pidFile}; echo done`]);
        expect(result).toMatchObject({ exitCode: 0, lingering: true });
        expect(result.stdout.text).toBe("done\n");
        expect(Date.now() - started).toBeLessThan(10_000);
        process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL");
    });

    it("stops the command when the caller aborts", async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 200);
        const result = await runBounded("/bin/sh", ["-c", "sleep 30"], { signal: controller.signal, killGraceMs: 100 });
        expect(result).toMatchObject({ aborted: true, timedOut: false, exitCode: null, exitSignal: "SIGTERM" });
    });

    it("does not start a command whose signal is already aborted", async () => {
        const dir = mkdtempSync(join(tmpdir(), "process-"));
        const marker = join(dir, "ran");
        const result = await runBounded("/bin/sh", ["-c", `touch ${marker}`], { signal: AbortSignal.abort() });
        expect(result.aborted).toBe(true);
        expect(existsSync(marker)).toBe(false);
    });

    it("keeps the head and tail of output past its cap and counts the middle", async () => {
        const result = await runBounded("/bin/sh", ["-c", "printf 'a%.0s' $(seq 1 50); printf 'b%.0s' $(seq 1 50)"], { maxOutput: 20 });
        expect(result.stdout).toEqual({ text: `aaaaaaaaaa\n… [80 characters cut] …\nbbbbbbbbbb`, dropped: 80 });
    });

    it("feeds stdin when given input", async () => {
        const result = await runBounded("/bin/sh", ["-c", "cat"], { input: "fed\n" });
        expect(result.stdout.text).toBe("fed\n");
    });
});

describe("textCollector", () => {
    it("decodes a character split across two chunks whole", () => {
        const euro = Buffer.from("€", "utf8");
        const sink = textCollector(100);
        sink.write(euro.subarray(0, 1));
        sink.write(euro.subarray(1));
        expect(sink.end()).toEqual({ text: "€", dropped: 0 });
    });
});

describe("clipText", () => {
    it("leaves a short text alone and cuts a long one in the middle", () => {
        expect(clipText("short", 10)).toEqual({ text: "short", dropped: 0 });
        expect(clipText("0123456789abcdef", 10)).toEqual({ text: "01234\n… [6 characters cut] …\nbcdef", dropped: 6 });
    });
});

describe("runBoundedBytes", () => {
    it("keeps stdout as bytes up to its limit and counts the rest", async () => {
        const result = await runBoundedBytes("/bin/sh", ["-c", "printf 'abcdef'"], { maxStdoutBytes: 4 });
        expect(result.stdout.bytes.toString("utf8")).toBe("abcd");
        expect(result.stdout.dropped).toBe(2);
    });
});

describe("execBounded", () => {
    it("answers stdout and stderr of a command that succeeded", async () => {
        expect(await execBounded("/bin/sh", ["-c", "echo hi"])).toEqual({ stdout: "hi\n", stderr: "" });
    });

    it("throws execFile's shape for a non-zero exit", async () => {
        const failure: unknown = await execBounded("/bin/sh", ["-c", "echo nope >&2; exit 2"]).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ProcessError);
        expect(failure).toMatchObject({ code: 2, stderr: "nope\n", killed: false });
    });

    it("throws the errno for a binary that is not there", async () => {
        const failure: unknown = await execBounded("/no/such/binary-anywhere", []).catch((error: unknown) => error);
        expect(failure).toMatchObject({ code: "ENOENT" });
    });
});

describe("stopping", () => {
    it("reports a command that heeds SIGTERM as stopped without waiting out the grace", async () => {
        const started = Date.now();
        const result = await runBounded("/bin/sh", ["-c", "sleep 30"], { timeoutMs: 100, killGraceMs: 5_000 });
        expect(result.timedOut).toBe(true);
        expect(Date.now() - started).toBeLessThan(2_000);
    });
});

describe("runBoundedSync", () => {
    it("answers a command's exit code and output", () => {
        const result = runBoundedSync("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"], { timeoutMs: 10_000 });
        expect(result).toMatchObject({ exitCode: 3, timedOut: false, lingering: false, overflowed: false });
        expect(result.stdout.text).toBe("out\n");
        expect(result.stderr.text).toBe("err\n");
    });

    it("reports a missing binary in the result rather than throwing", () => {
        const result = runBoundedSync("/no/such/binary-anywhere", [], { timeoutMs: 10_000 });
        expect(result.exitCode).toBe(null);
        expect(result.spawnError).toMatchObject({ code: "ENOENT" });
    });

    it("kills the whole process group at the deadline, grandchildren included", () => {
        const pidFile = join(mkdtempSync(join(tmpdir(), "process-")), "pid");
        const started = Date.now();
        const result = runBoundedSync("/bin/sh", ["-c", `sleep 30 & echo $! > ${pidFile}; wait`], { timeoutMs: 300, killGraceMs: 100 });
        expect(result).toMatchObject({ timedOut: true, lingering: false });
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(alive(Number(readFileSync(pidFile, "utf8").trim()))).toBe(false);
    });

    it("ends a grandchild that holds the pipe after the command itself exited, at the deadline", () => {
        const pidFile = join(mkdtempSync(join(tmpdir(), "process-")), "pid");
        const started = Date.now();
        // The shell exits at once; the background sleep inherits stdout and would hold it for 30 s.
        const result = runBoundedSync("/bin/sh", ["-c", `sleep 30 & echo $! > ${pidFile}; echo done`], { timeoutMs: 500, killGraceMs: 100 });
        expect(result).toMatchObject({ exitCode: 0, timedOut: true, lingering: true });
        expect(result.stdout.text).toBe("done\n");
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(alive(Number(readFileSync(pidFile, "utf8").trim()))).toBe(false);
    });

    it("discards output when asked to and feeds stdin when given input", () => {
        expect(runBoundedSync("/bin/sh", ["-c", "echo hidden"], { timeoutMs: 10_000, output: "ignore" }).stdout.text).toBe("");
        expect(runBoundedSync("/bin/sh", ["-c", "cat"], { timeoutMs: 10_000, input: "fed\n" }).stdout.text).toBe("fed\n");
    });

    it("keeps the head and tail of output past its cap", () => {
        const result = runBoundedSync("/bin/sh", ["-c", "printf 'a%.0s' $(seq 1 50); printf 'b%.0s' $(seq 1 50)"], { timeoutMs: 10_000, maxOutput: 20 });
        expect(result.stdout).toEqual({ text: `aaaaaaaaaa\n… [80 characters cut] …\nbbbbbbbbbb`, dropped: 80 });
    });

    it("keeps stdout as bytes up to its limit in the bytes variant", () => {
        const result = runBoundedSyncBytes("/bin/sh", ["-c", "printf 'abcdef'"], { timeoutMs: 10_000, maxStdoutBytes: 4 });
        expect(result.stdout).toEqual({ bytes: Buffer.from("abcd"), dropped: 2 });
    });
});
