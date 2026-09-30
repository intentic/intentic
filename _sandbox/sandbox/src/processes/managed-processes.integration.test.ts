import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../logger.js";
import { pinTmuxServer } from "../terminal/tmux-server.js";
import { createManagedProcesses } from "./managed-processes.js";

// Runs the default tmux runner against a real server (src/fences/tmux-fence.ts's private `-S` shim).

const execFileAsync = promisify(execFile);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

// The boot restore's case: the pin has left the server running with no session in it, and the first thing it is asked
// to run is dockerd (or a model server). Clearing a same-name leftover first must find nothing to clear, not fail the
// start, which is what left the docker capability reading "dockerd not running" after every restart.
test("a panel starts on the pinned server before it holds any session", async () => {
    await pinTmuxServer(logger);
    const cwd = await mkdtemp(join(tmpdir(), "managed-processes-"));
    const processes = createManagedProcesses(undefined, { onPromptWatch: () => () => undefined, logger });
    try {
        await processes.start("probe", { command: "sleep 30", cwd });

        expect(processes.running("probe")).toBe(true);
        await expect(execFileAsync("tmux", ["has-session", "-t", "=panel-probe"])).resolves.toBeDefined();
    } finally {
        await processes.stop("probe");
        await rm(cwd, { recursive: true, force: true });
    }
    await expect(execFileAsync("tmux", ["has-session", "-t", "=panel-probe"])).rejects.toThrow();
});
