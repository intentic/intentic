#!/usr/bin/env node
// Builds the plugin in place: one self-contained esbuild bundle per entry in dist/ (no node_modules at install time, which
// is what a marketplace install gives a plugin), then generated/ and the manifest's version from src/emit.ts.
//   node build.mjs              build
//   node build.mjs --validate   build, then `claude plugin validate --strict .` when a claude CLI is on PATH
// The mod (hooks/register.ts, named by `modules` in hooks/hooks.json) is not bundled: Claude Code loads TypeScript hooks
// modules itself, in an environment with no Node, so it is one self-contained source file that ships as it is.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const root = import.meta.dirname;
const dist = join(root, "dist");

// Hooks run on every session start, tool call and prompt, so each is its own small bundle rather than one that parses
// fileq's document stack on every Bash call.
const ENTRIES = {
    "session-start": "src/session-start.ts",
    "post-bash": "src/post-bash.ts",
    "prompt-submit": "src/prompt-submit.ts",
    stats: "src/stats.ts",
    "notes-evidence": "src/notes-evidence.ts",
    emit: "src/emit.ts",
    fileq: "../fileq/src/cli.ts",
    "retrieve-output": "../output-cleaners/src/retrieve-output.mjs",
};

rmSync(dist, { recursive: true, force: true });
await build({
    absWorkingDir: root,
    entryPoints: ENTRIES,
    outdir: dist,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    // Claude Code's own floor; nothing here needs newer.
    target: "node20",
    // Workspace packages resolve to their TypeScript sources, as everywhere else in this repository.
    conditions: ["@intentic/src"],
    // Bundled CommonJS (exceljs, mammoth) still calls `require` for node builtins.
    banner: { js: "import { createRequire as __intenticRequire } from 'node:module'; const require = __intenticRequire(import.meta.url);" },
    legalComments: "none",
    logLevel: "warning",
});

// npm packs a file with the mode it has on disk, and Claude runs bin/ by name; a checkout that dropped the executable
// bit (core.fileMode off, a Windows filesystem) would ship commands that answer "Permission denied".
for (const name of readdirSync(join(root, "bin"))) {
    chmodSync(join(root, "bin", name), 0o755);
}

// A `modules` entry that points at nothing would load no mod at all, and nothing at install time says so; fail here instead.
const hooksFile = join(root, "hooks", "hooks.json");
for (const module of JSON.parse(readFileSync(hooksFile, "utf8")).modules ?? []) {
    if (!existsSync(join(root, "hooks", module))) {
        console.error(`build: hooks/hooks.json names the module ${module}, which is not in hooks/`);
        process.exit(1);
    }
}

const emitted = spawnSync(process.execPath, [join(dist, "emit.mjs"), root], { cwd: root, stdio: "inherit" });
rmSync(join(dist, "emit.mjs"), { force: true });
if (emitted.status !== 0) {
    process.exit(emitted.status ?? 1);
}

if (process.argv.includes("--validate")) {
    const claude = spawnSync("claude", ["plugin", "validate", "--strict", root], { stdio: "inherit" });
    if (claude.error !== undefined) {
        console.error("build: no `claude` on PATH, so the manifest was built but not validated");
    }
    process.exit(claude.status ?? 0);
}
