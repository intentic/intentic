import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";

// The `diagnostics` command's flags as an agent types them, read before any daemon call: SANDBOX_PORT 1 answers nothing,
// so a flag that passed the parse ends on the daemon (or its token), never on the parse's own refusal.
const DIAGNOSTICS = join(packageRoot(import.meta.url), "bin", "diagnostics");
const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [DIAGNOSTICS, ...args], { encoding: "utf8", env: { ...process.env, SANDBOX_PORT: "1" } });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
};

// The MCP tool calls the end of an absolute window `until`, and agents copied `--to` beside `--from` (2026-11).
test("`errors --to` is `--until`, and the help says so; a flag errors does not take is still refused", () => {
    expect(run("errors", "--from", "2026-11-01T00:00:00Z", "--to", "2026-11-01T01:00:00Z").out).not.toContain("takes no");
    expect(run("errors", "--to=2026-11-01T01:00:00Z").out).not.toContain("takes no");
    expect(run("errors", "--bogus", "x").out).toContain("diagnostics: errors takes no --bogus");
    expect(run("turns", "--to", "x").out).toContain("diagnostics: turns takes no --to");
    expect(run("--help").out).toContain("[--until|--to <ISO time>]");
});
