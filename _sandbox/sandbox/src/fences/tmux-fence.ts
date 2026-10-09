import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suiteKindOf } from "@intentic/constants/test-suites";
import { afterAll, beforeAll } from "bun:test";

// Preload, not a helper: fences tmux suites off the real server (the daemon's own, shared with live shells).
// Seam is a `tmux` shim on PATH pointing at a private socket; TMUX_TMPDIR doesn't work (tmux 3.3a silently ignores it).

let dir: string | undefined;

beforeAll(() => {
    // Only a suite that reaches for the machine can reach tmux.
    if (suiteKindOf(Bun.main) === "unit") {
        return;
    }
    // Resolve before the shim goes on PATH, without a synchronous shell that can hang a worker's setup on CI.
    const binary = Bun.which("tmux");
    if (binary === null) {
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
    // Most suites never start tmux: only a private server's socket needs a shutdown subprocess.
    if (existsSync(join(dir, "sock"))) {
        try {
            execFileSync("tmux", ["kill-server"], { stdio: "ignore" });
        } catch {
            // The private server already stopped, which leaves nothing to shut down.
        }
    }
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
});
