import { adbRunner } from "./android.js";

/* The real runner, over this test's own runtime standing in for adb: what a phone sends back is bytes (a screenshot),
   and adb's first call leaves a server behind that can hold the pipes long after the call has answered. */

const run = adbRunner(process.execPath);

test("the runner hands back the exit code, stdout's bytes untouched, and stderr", async () => {
    const output = await run(
        ["-e", "process.stdout.write(Buffer.from([0x89, 0x50, 0x0d, 0x0a, 0xff])); process.stderr.write('warn'); process.exit(3)"],
        20_000,
    );
    expect(output).toEqual({ code: 3, stdout: Buffer.from([0x89, 0x50, 0x0d, 0x0a, 0xff]), stderr: "warn", timedOut: false });
});

test("a program past its deadline is stopped and said to have timed out", async () => {
    const started = Date.now();
    const output = await run(["-e", "setTimeout(() => {}, 60000)"], 300);
    expect(output.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
});

test("something the program left running with its pipes does not hold the answer", async () => {
    const started = Date.now();
    const output = await run(
        [
            "-e",
            "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'inherit', detached: true }).unref(); console.log('answered')",
        ],
        20_000,
    );
    expect(output.stdout.toString("utf8")).toBe("answered\n");
    expect(output.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(3_500);
});
