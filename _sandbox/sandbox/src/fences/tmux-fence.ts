import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

// Vitest setup, not a helper: fences tmux suites off the real server (the daemon's own, shared with live shells).
// Seam is a `tmux` shim on PATH pointing at a private socket; TMUX_TMPDIR doesn't work (tmux 3.3a silently ignores it).

let dir: string | undefined;

beforeAll(() => {
    let binary: string;
    try {
        // Resolved before the shim goes on PATH, and by absolute path, so the shim can reach past itself.
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
    // Both route past the shim onto the shared server: $TMUX wins over argv's socket; INTENTIC_TMUX_NS nsenters first.
    // Deleted rather than blanked; the wrapper tests `-n`, so empty reads as absent anyway.
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
