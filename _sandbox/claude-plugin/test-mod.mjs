#!/usr/bin/env node
// Runs the mod's tests with `claude plugin test`, which executes every *.test.ts under the plugin and so would also run
// this package's bun tests (src/) as engine tests. The mod and its tests are copied to a scratch plugin first.
//   node test-mod.mjs [claude]   (the claude CLI, default `claude`; CLAUDE_CONFIG_DIR is isolated to a temp directory)
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = import.meta.dirname;
const scratch = mkdtempSync(join(tmpdir(), "intentic-mod-test-"));
try {
    mkdirSync(join(scratch, "plugin"));
    for (const name of [".claude-plugin", "hooks", "tests"]) {
        cpSync(join(root, name), join(scratch, "plugin", name), { recursive: true });
    }
    const claude = process.argv[2] ?? "claude";
    const ran = spawnSync(claude, ["plugin", "test", join(scratch, "plugin")], {
        stdio: "inherit",
        env: { ...process.env, CLAUDE_CONFIG_DIR: join(scratch, "config") },
    });
    if (ran.error !== undefined) {
        console.error(`test-mod: could not run \`${claude}\`: ${ran.error.message}`);
        process.exit(1);
    }
    process.exit(ran.status ?? 1);
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
