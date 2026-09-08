import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { createLogger } from "../logger.js";
import { pinTmuxServer, tmuxServerLeaked } from "./tmux-server.js";

// Runs against a real tmux server (src/testing/tmux-fence.ts's private `-S` shim), exercising the pin and proving the
// fence: nothing here can reach the daemon's socket even though every call is bare `tmux`.

const execFileAsync = promisify(execFile);
const tmux = async (...args: string[]): Promise<string> => (await execFileAsync("tmux", args)).stdout.trim();
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

test("the pin leaves a server running with no sessions, which is what stops anything else from forking one", async () => {
    await pinTmuxServer(logger);

    // `exit-empty off` stops tmux exiting when its last session dies, which would fork a fresh server on next use.
    expect(await tmux("show-options", "-gv", "exit-empty")).toBe("off");
    // The holder was fork scaffolding and must not survive as a phantom terminal in the panel's list.
    await expect(execFileAsync("tmux", ["has-session", "-t", "=intentic-server-pin"])).rejects.toThrow();
    // Alive with nothing in it: `display -p` only answers when a server is behind it.
    expect(Number(await tmux("display", "-p", "#{pid}"))).toBeGreaterThan(0);
    expect(await tmux("list-sessions", "-F", "#{session_name}").catch(() => "")).toBe("");
});

test("a second pin is a no-op rather than an error, so a daemon restart inside a live container is safe", async () => {
    await pinTmuxServer(logger);
    const first = await tmux("display", "-p", "#{pid}");
    await pinTmuxServer(logger);

    // Same server: `new-session -A` attached instead of erroring; nothing forked a second one.
    expect(await tmux("display", "-p", "#{pid}")).toBe(first);
});

// This process forked the server, so they share a namespace and the check must stay quiet; it only flags a server the
// daemon did not fork.
test("a server forked from here reports no namespace leak", async () => {
    await pinTmuxServer(logger);

    expect(await tmuxServerLeaked()).toBeUndefined();
});
