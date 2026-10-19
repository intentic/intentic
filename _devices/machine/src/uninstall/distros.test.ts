import { stderrBlocks } from "./distros.js";

/* What a distro's purge said on stderr in plain mode, read back block by block: each warning with its `fix:` line, so
   the Windows side says it as a warning of its own, and the stop it ended in, if any. */

test("a warning keeps its fix line, and two warnings stay two", () => {
    const stderr = ["intentic: Lingering stays on for your user (no bus).", "             fix:     loginctl disable-linger", "intentic: A sandbox still lists this device.", ""].join("\n");
    expect(stderrBlocks(stderr)).toEqual({
        warnings: ["Lingering stays on for your user (no bus).\n   fix:     loginctl disable-linger", "A sandbox still lists this device."],
        stop: [],
    });
});

test("a stop is told apart from the warnings before it, with its problem and fix", () => {
    const stderr = ["intentic: Lingering stays on.", "error: The agent was not removed from this device entirely.", "   problem: the agent is still running (pid 7).", "   fix:     kill 7"].join("\n");
    expect(stderrBlocks(stderr)).toEqual({
        warnings: ["Lingering stays on."],
        stop: ["The agent was not removed from this device entirely.\n   problem: the agent is still running (pid 7).\n   fix:     kill 7"],
    });
});

test("lines before any prefix (wsl.exe's own) start no block", () => {
    expect(stderrBlocks("The Windows Subsystem for Linux is starting.\n")).toEqual({ warnings: [], stop: [] });
});
