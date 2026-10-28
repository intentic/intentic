import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../logger.js";
import { pinTmuxServer } from "../terminal/tmux-server.js";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { createManagedProcesses, type ProcessRunner } from "./managed-processes.js";

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

// A runner that lets the test say each session's foreground command, as tmux reports it; launch starts at "node".
const scriptedRunner = () => {
    const cmd = new Map<string, string>();
    const runner: ProcessRunner = {
        launch: async (session) => {
            cmd.set(session, "node");
        },
        kill: (session) => {
            cmd.delete(session);
        },
        states: async () => new Map(cmd),
    };
    return { runner, cmd };
};

const SPEC = { command: "pnpm dev", cwd: join(WORKSPACE_ROOT, "app", "operator") };

afterEach(() => {
    jest.useRealTimers();
});

test("launchOf narrates a start: launching until the command is seen, starting while it runs, exited once it returns to a prompt", async () => {
    jest.useFakeTimers();
    const { runner, cmd } = scriptedRunner();
    const panels = createManagedProcesses(runner, { onPromptWatch: () => () => undefined });
    // A Node directory with no node_modules and no install-completion file yet.
    const app = mkdtempSync(join(tmpdir(), "launch-"));
    writeFileSync(join(app, "package.json"), "{}");
    // The fake reports the job command only from the first sweep on; before that nothing's been seen.
    await panels.start("app", { ...SPEC, cwd: app });
    // A directory with no package.json (a Cargo crate) has nothing to install: its run is starting from the first sight.
    await panels.start("game", { command: "cargo run", cwd: mkdtempSync(join(tmpdir(), "launch-")) });
    expect(panels.launchOf("app")).toBe("launching");
    await advanceTimersByTimeAsync(2_000);
    expect(panels.launchOf("app")).toBe("installing");
    expect(panels.launchOf("game")).toBe("starting");
    cmd.set("panel-app", "zsh");
    await advanceTimersByTimeAsync(2_000);
    expect(panels.launchOf("app")).toBe("exited");
    // Not running at all, and a one-shot job, both answer nothing.
    expect(panels.launchOf("site")).toBeUndefined();
    await panels.start("job", { ...SPEC, oneShot: true });
    expect(panels.launchOf("job")).toBeUndefined();
    panels.stopAll();
});
