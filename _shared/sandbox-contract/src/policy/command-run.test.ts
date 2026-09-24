import type { CommandRun } from "../schemas/ci.js";
import { followCommandRun } from "./command-run.js";

const RUNNING: CommandRun = { status: "running", command: "pnpm test", output: "" };
const PASSED: CommandRun = { status: "passed", command: "pnpm test", output: "ok" };

test("a poll that fails is reported and retried, and the run is still followed to its verdict", async () => {
    const answers: Array<CommandRun | Error> = [new Error("daemon restarting"), RUNNING, PASSED];
    const errors: unknown[] = [];
    const settled = await followCommandRun(
        async () => {
            const next = answers.shift();
            if (next instanceof Error) {
                throw next;
            }
            return next as CommandRun;
        },
        { intervalMs: 1, onError: (cause) => errors.push(cause) },
    );
    expect(settled).toEqual(PASSED);
    expect(errors).toEqual([new Error("daemon restarting")]);
});

test("a throw from onState is the caller's bug and reaches the caller, not a poll failure retried forever", async () => {
    const errors: unknown[] = [];
    const following = followCommandRun(async () => RUNNING, {
        intervalMs: 1,
        onState: () => {
            throw new TypeError("state.session is undefined");
        },
        onError: (cause) => errors.push(cause),
    });
    await expect(following).rejects.toThrow("state.session is undefined");
    expect(errors).toEqual([]);
});
