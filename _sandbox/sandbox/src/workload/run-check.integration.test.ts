import { mkdtempSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { getPriority, tmpdir } from "node:os";
import { join } from "node:path";
import { requires } from "@intentic/testing/requires";
import { OOM_SCORE } from "./workload-class.js";
import { type CheckSpec, runCheck, shellArgv } from "./run-check.js";

/* Against real children: what a deadline leaves running and what rank a command runs at are only seen in procfs. */

const SETTLE_MS = 5_000;
const POLL_MS = 50;

const scratch = (): string => mkdtempSync(join(tmpdir(), "run-check-"));

const base = (command: string, cwd: string, overrides: Partial<Omit<CheckSpec, "argv">> = {}): CheckSpec => ({
    argv: shellArgv(command, "sh"),
    cwd,
    timeoutMs: 10_000,
    workload: { class: "command" },
    kind: "watch-check",
    captureBytes: 1024,
    graceMs: 200,
    ...overrides,
});

// Gone, or a zombie no parent has reaped yet: either way nothing of it runs.
const ended = async (pid: number): Promise<boolean> => {
    const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8").catch(() => "");
    return stat === "" || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
};

const endedWithin = async (pid: number): Promise<boolean> => {
    const deadline = Date.now() + SETTLE_MS;
    while (!(await ended(pid)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return ended(pid);
};

const pidIn = (cwd: string, file: string): number => Number(readFileSync(join(cwd, file), "utf8").trim());

const linux = requires(process.platform === "linux", "Linux, whose procfs shows what a deadline left running");

describe.skipIf(!linux.runs)(linux.title("a deadline ends the whole command"), () => {
    // The copies this replaced killed only the shell: the sleep lived on and held the output pipe past the deadline.
    test("a command past its deadline is ended with everything its shell started", async () => {
        const cwd = scratch();

        const ran = await runCheck(base("sleep 31 & echo $! > child.pid; wait", cwd, { timeoutMs: 500 }));

        expect(ran).toMatchObject({ exitCode: undefined, ended: "timeout" });
        expect(await endedWithin(pidIn(cwd, "child.pid"))).toBe(true);
    });

    test("a grandchild that ignores SIGTERM is killed once the grace runs out", async () => {
        const cwd = scratch();

        const ran = await runCheck(base(`sh -c 'trap "" TERM; echo $$ > grandchild.pid; exec sleep 31' & wait`, cwd, { timeoutMs: 500 }));

        expect(ran.ended).toBe("timeout");
        expect(await endedWithin(pidIn(cwd, "grandchild.pid"))).toBe(true);
    });

    test("an abort ends it the same way, and an abort before the start runs nothing", async () => {
        const cwd = scratch();
        const controller = new AbortController();
        const pending = runCheck(base("sleep 31 & echo $! > child.pid; wait", cwd, { signal: controller.signal }));
        setTimeout(() => controller.abort(), 300);

        expect((await pending).ended).toBe("aborted");
        expect(await endedWithin(pidIn(cwd, "child.pid"))).toBe(true);
        expect(await runCheck(base("touch ran", cwd, { signal: AbortSignal.abort() }))).toEqual({
            exitCode: undefined,
            stdout: "",
            stderr: "",
            truncated: false,
            ended: "aborted",
        });
    });
});

describe("what a command said", () => {
    test("its exit code and both streams come back as printed", async () => {
        expect(await runCheck(base("echo out; echo err >&2; exit 3", scratch()))).toEqual({
            exitCode: 3,
            stdout: "out\n",
            stderr: "err\n",
            truncated: false,
        });
    });

    test("interleaved, both streams arrive in one transcript", async () => {
        const ran = await runCheck(base("echo one; sleep 0.1; echo two >&2", scratch(), { interleave: true }));

        expect(ran).toEqual({ exitCode: 0, stdout: "one\ntwo\n", stderr: "", truncated: false });
    });

    test("stdin is handed over and closed", async () => {
        expect((await runCheck(base("cat", scratch(), { stdin: "the script" }))).stdout).toBe("the script");
    });

    test("past the cap the head is kept and the command runs on to its own exit", async () => {
        const ran = await runCheck(base("head -c 5000 /dev/zero | tr '\\0' a; echo; exit 4", scratch(), { captureBytes: 10 }));

        expect(ran).toEqual({ exitCode: 4, stdout: "aaaaaaaaaa", stderr: "", truncated: true });
    });

    test("kept by its tail, the end survives", async () => {
        const ran = await runCheck(base("head -c 5000 /dev/zero | tr '\\0' a; echo END", scratch(), { captureBytes: 6, keep: "tail" }));

        expect(ran).toEqual({ exitCode: 0, stdout: "aaEND\n", stderr: "", truncated: true });
    });

    test("an overflow the caller reads as failure ends the command", async () => {
        const ran = await runCheck(base("yes", scratch(), { captureBytes: 4096, killOnOverflow: true }));

        expect(ran).toMatchObject({ exitCode: undefined, truncated: true, ended: "overflow" });
    });

    test("a program that is not there says why it never started", async () => {
        const ran = await runCheck({ ...base("", scratch()), argv: ["intentic-no-such-program"] });

        expect(ran.exitCode).toBeUndefined();
        expect(ran.spawnError).toContain("intentic-no-such-program");
    });

    test("its deadline rides in its environment for the reaper", async () => {
        const before = Date.now();
        const ran = await runCheck(base('echo "$INTENTIC_DETACHED $INTENTIC_DEADLINE"', scratch(), { timeoutMs: 60_000 }));
        const [kind, deadline] = ran.stdout.trim().split(" ");

        expect(kind).toBe("watch-check");
        expect(Number(deadline)).toBeGreaterThanOrEqual(before + 60_000);
        expect(Number(deadline)).toBeLessThanOrEqual(Date.now() + 60_001);
    });
});

// Children inherit this process's rank and a class never lowers one, so only a class above it can be seen to land.
const INHERITED = process.platform === "linux" ? Number(readFileSync("/proc/self/oom_score_adj", "utf8").trim()) : 0;
const kernel = requires(
    process.platform === "linux" && INHERITED < OOM_SCORE.command && getPriority() < 19,
    `Linux, with this process ranked below an agent's command (it inherited oom_score_adj ${String(INHERITED)}, niceness ${String(getPriority())})`,
);

describe.skipIf(!kernel.runs)(kernel.title("a command runs in the class its caller names"), () => {
    test("ranked for the OOM killer and niced as its class, not as the daemon", async () => {
        const ran = await runCheck(base("sleep 0.2; nice; cat /proc/$$/oom_score_adj", scratch()));

        expect(ran.stdout).toBe(`19\n${String(OOM_SCORE.command)}\n`);
    });
});
