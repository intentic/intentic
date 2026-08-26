import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { createLogger } from "../logger.js";
import { pinTmuxServer, tmuxServerLeaked } from "./tmux-server.js";

/* Against a REAL server, because the whole mechanism is one tmux behaviour and an argv assertion would only
 * restate the source. The server is the suite's private one (src/testing/tmux-fence.ts puts a `-S` shim on
 * PATH for every integration project here), so this both exercises the pin and proves the fence: nothing below
 * can reach the daemon's socket even though every call is a bare `tmux`.
 */

const execFileAsync = promisify(execFile);
const tmux = async (...args: string[]): Promise<string> => (await execFileAsync("tmux", args)).stdout.trim();
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

test("the pin leaves a server running with no sessions, which is what stops anything else from forking one", async () => {
    await pinTmuxServer(logger);

    // `exit-empty off` is the whole trick: tmux's default is to exit when its last session is destroyed, and
    // the next client to want one would then fork a server carrying ITS mounts (terminal/tmux-server.ts).
    expect(await tmux("show-options", "-gv", "exit-empty")).toBe("off");
    // The holder was scaffolding for the fork and must not survive as a phantom terminal in the panel's list.
    await expect(execFileAsync("tmux", ["has-session", "-t", "=intentic-server-pin"])).rejects.toThrow();
    // Alive with nothing in it: `display -p` answers, which no client can do without a server behind it.
    expect(Number(await tmux("display", "-p", "#{pid}"))).toBeGreaterThan(0);
    expect(await tmux("list-sessions", "-F", "#{session_name}").catch(() => "")).toBe("");
});

test("a second pin is a no-op rather than an error, so a daemon restart inside a live container is safe", async () => {
    await pinTmuxServer(logger);
    const first = await tmux("display", "-p", "#{pid}");
    await pinTmuxServer(logger);

    // Same server: `new-session -A` attached instead of erroring, and nothing forked a second one.
    expect(await tmux("display", "-p", "#{pid}")).toBe(first);
});

// The invariant the pin exists to hold. This process forked that server, so the two share a namespace and the
// check must stay quiet; it speaks only for a server the daemon did NOT fork, which is the leak it names.
test("a server forked from here reports no namespace leak", async () => {
    await pinTmuxServer(logger);

    expect(await tmuxServerLeaked()).toBeUndefined();
});
