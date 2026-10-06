import { run } from "./run.js";
import type { DesktopError } from "./types.js";

/* What `run` says when a program fails, and which of those sentences may send someone off to install something. */

const INSTALL = "sudo apt install the-tool";
// The test runner's own binary stands in for a program, so this needs nothing on PATH.
const node = (script: string): [string, string[]] => [process.execPath, ["-e", script]];

const failure = async (command: string, args: readonly string[], install: string | undefined, timeoutMs?: number): Promise<DesktopError> => {
    try {
        await run(command, args, install, timeoutMs);
    } catch (error) {
        return error as DesktopError;
    }
    throw new Error("expected the program to fail");
};

test("a program that is not there is the one failure that carries its install hint", async () => {
    const error = await failure("intentic-no-such-program", [], INSTALL);
    expect(error.message).toContain(`no "intentic-no-such-program"`);
    expect(error.install).toBe(INSTALL);
});

// The sandbox appends "the browser pack installs what the desktop needs; it arrives with the next rebuild" to any error
// that has an install hint, so a hint on a program that IS installed sends the agent to wait for a rebuild that fixes nothing.
test("a program that is installed and timed out says so and does not point at an install", async () => {
    const error = await failure(...node("setTimeout(() => {}, 5000)"), INSTALL, 150);
    expect(error.message).toContain("did not answer within");
    expect(error.install).toBeUndefined();
});

test("a program that is installed and failed says what it said and does not point at an install", async () => {
    const error = await failure(...node("console.error('no such window'); process.exit(3)"), INSTALL);
    expect(error.message).toContain("no such window");
    expect(error.install).toBeUndefined();
});
