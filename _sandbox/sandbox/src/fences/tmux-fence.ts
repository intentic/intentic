import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

/* THE SUITE DOES NOT GET TO TOUCH THE OWNER'S TERMINALS. A vitest setup file, not a helper, because the tests
 * that need it do not know they do.
 *
 * Several integration suites here drive tmux for real — that is the point of them: terminal-run's `job-*`
 * sessions, the capability handlers' `job-capability-*`, terminal-help's window queries. On a developer's
 * laptop that is a private tmux nobody is using. In THIS sandbox it is the daemon's own server, the one every
 * live agent's shell and every terminal tab the owner has open is inside. A full `pnpm test` run left
 * `job-test`, `job-echo`, `job-env`, `job-exec`, `job-serial` and three `job-capability-*` sessions sitting in
 * the owner's terminals panel, and those are only the ones that CREATE something; a suite that kills sessions
 * on that socket takes the owner's shells down with them.
 *
 * The sharper reason is the one that already cost work. An agent runs the suite inside its own mount namespace
 * (`/work` is that conversation's worktree there), so every tmux client the suite spawns stands in a private
 * `/work` — and a client that finds no server running forks one, which then keeps those mounts for life, for
 * every pane it ever creates, the owner's terminal tabs included (terminal/tmux-server.ts). The daemon now
 * forks the server itself at boot to close that race; this closes the other half of it, by making the suite
 * unable to reach that socket at all.
 *
 * A `tmux` SHIM ON PATH is the seam, and it is the only one available: the code under test shells out to a
 * bare `tmux`, and adding a socket parameter to production code for the sake of a test would be putting the
 * test's shape into the daemon. TMUX_TMPDIR looks like the obvious answer and is not — tmux 3.3a ignores it,
 * silently, and the sessions land on the shared server anyway (agent-terminals.integration.test.ts found that
 * out the hard way, and its own `-S` shim is the pattern this generalises).
 */

let dir: string | undefined;

beforeAll(() => {
    let binary: string;
    try {
        // Resolved BEFORE the shim goes on PATH, and by absolute path, so the shim can reach past itself.
        binary = execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim();
    } catch {
        // No tmux on this machine: nothing to fence, and every suite that wanted one already degrades.
        return;
    }
    dir = mkdtempSync(join(tmpdir(), "tmux-fence-"));
    writeFileSync(join(dir, "tmux"), `#!/usr/bin/env bash\nexec ${JSON.stringify(binary)} -S ${JSON.stringify(join(dir, "sock"))} "$@"\n`, {
        mode: 0o755,
    });
    process.env["PATH"] = `${dir}:${process.env["PATH"] ?? ""}`;
    /* Both of these would route past the shim and back onto the shared server. `$TMUX` is set whenever the
     * suite itself runs inside a tmux pane — which, for an agent running the tests, is always — and tmux
     * prefers it over the socket in argv. `INTENTIC_TMUX_NS` makes bin/tmux-run `nsenter` to the daemon before
     * it calls tmux at all, which is right in production and wrong here: it would carry the wrapper out of the
     * fence. Deleted rather than blanked; the wrapper tests `-n`, and an empty value reads as absent anyway.
     */
    delete process.env["TMUX"];
    delete process.env["INTENTIC_TMUX_NS"];
});

afterAll(() => {
    if (dir === undefined) {
        return;
    }
    // The private server dies with the run whatever the suites left on it; nothing outside this dir is named.
    try {
        execFileSync("tmux", ["kill-server"], { stdio: "ignore" });
    } catch {
        // No server was ever started, which is the common case and not a failure.
    }
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
});
