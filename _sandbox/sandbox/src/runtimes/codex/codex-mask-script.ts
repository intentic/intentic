import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { shellQuote } from "@intentic/sandbox-run/quote";
import type { MaskTarget } from "../../agent/tools/agent-redaction.js";

// The wrapper a Codex shell command runs through while the turn holds stored secrets: Codex hands a hook no way to
// rewrite a command's output (its PostToolUse takes no replaced output for a shell), so the command is rewritten instead
// to run under this script, which prints what it printed with every stored value turned back into its
// `{{secret:name}}` reference before Codex, and so its model, reads it. The command and the values travel by a file the
// script deletes as it reads it, so neither stands in the command line Codex shows, logs and hands back to the model.
// Kept apart from the hook that writes it (codex-hooks.ts) because this is text another process runs.

const SCRIPT_NAME = "intentic-codex-mask.mjs";

// Plain JavaScript with no template literals, so nothing in it reads as this file's interpolation. A value is held back
// only while the output so far ends in what could still be the start of one; anything else goes out at once, so a prompt
// waiting on input is seen.
export const maskScript = (): string =>
    [
        `// managed by intentic: written per Codex turn (src/runtimes/codex/codex-mask-script.ts).`,
        `import { spawn } from "node:child_process";`,
        `import { existsSync, readFileSync, rmSync } from "node:fs";`,
        `import { constants } from "node:os";`,
        `import { StringDecoder } from "node:string_decoder";`,
        ``,
        `const file = process.argv[2] ?? "";`,
        `let spec;`,
        `try {`,
        `    spec = JSON.parse(readFileSync(file, "utf8"));`,
        `} catch {`,
        `    process.stdout.write("[Not run: this command's sandbox wrapper could not read it.]\\n");`,
        `    process.exit(1);`,
        `} finally {`,
        `    rmSync(file, { force: true });`,
        `}`,
        `const targets = Array.isArray(spec.targets) ? spec.targets : [];`,
        `const mask = (text) => targets.reduce((out, t) => (out.includes(t.target) ? out.split(t.target).join(t.replacement) : out), text);`,
        `// The longest end of the text that is the start of some value: held until the next chunk says which it was.`,
        `const pending = (text) => {`,
        `    let longest = 0;`,
        `    for (const t of targets) {`,
        `        for (let n = Math.min(t.target.length - 1, text.length); n > longest; n -= 1) {`,
        `            if (t.target.startsWith(text.slice(text.length - n))) {`,
        `                longest = n;`,
        `                break;`,
        `            }`,
        `        }`,
        `    }`,
        `    return longest;`,
        `};`,
        `const masker = (sink) => {`,
        `    const decoder = new StringDecoder("utf8");`,
        `    let held = "";`,
        `    return {`,
        `        write: (chunk) => {`,
        `            const text = mask(held + decoder.write(chunk));`,
        `            const keep = pending(text);`,
        `            held = text.slice(text.length - keep);`,
        `            sink.write(text.slice(0, text.length - keep));`,
        `        },`,
        `        end: () => {`,
        `            sink.write(mask(held + decoder.end()));`,
        `            held = "";`,
        `        },`,
        `    };`,
        `};`,
        `const shell = ["/bin/bash", "/usr/bin/bash", "/bin/sh"].find((path) => existsSync(path)) ?? "/bin/sh";`,
        // allow(process-tiers): the script runs outside the daemon, as Codex's own child, where no runCheck or spawnAs exists.
        `const child = spawn(shell, ["-c", String(spec.command ?? "")], { stdio: ["inherit", "pipe", "pipe"] });`,
        `const out = masker(process.stdout);`,
        `const err = masker(process.stderr);`,
        `child.stdout.on("data", out.write);`,
        `child.stderr.on("data", err.write);`,
        `let open = 2;`,
        `let status;`,
        `const finish = () => {`,
        `    if (open > 0 || status === undefined) {`,
        `        return;`,
        `    }`,
        `    out.end();`,
        `    err.end();`,
        `    process.exitCode = status;`,
        `};`,
        `child.stdout.on("close", () => { open -= 1; finish(); });`,
        `child.stderr.on("close", () => { open -= 1; finish(); });`,
        `child.on("error", (error) => {`,
        `    process.stderr.write("failed to start " + shell + ": " + error.message + "\\n");`,
        `    open = 0;`,
        `    status = 127;`,
        `    finish();`,
        `});`,
        `// A job the command left in the background can hold the pipes open for ever; its own exit ends this a moment later.`,
        `child.on("exit", (code, signal) => {`,
        `    status = code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1);`,
        `    setTimeout(() => { open = 0; finish(); process.exit(status); }, 250).unref();`,
        `    finish();`,
        `});`,
        `for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) {`,
        `    process.on(name, () => child.kill(name));`,
        `}`,
        ``,
    ].join("\n");

// One turn's wrapper: its script and the files each wrapped command travels by, in a directory only the daemon's user
// can read, removed when the turn ends.
export interface MaskWrapper {
    // The command line Codex runs in place of `command`, its output masked against `targets`.
    readonly wrap: (command: string, targets: readonly MaskTarget[]) => Promise<string>;
    readonly dispose: () => Promise<void>;
}

export const createMaskWrapper = (root: string): MaskWrapper => {
    let dir: Promise<string> | undefined;
    const ready = (): Promise<string> => {
        dir ??= (async () => {
            const made = await mkdtemp(join(root, "intentic-codex-"));
            await writeFile(join(made, SCRIPT_NAME), maskScript(), { mode: 0o600 });
            return made;
        })();
        return dir;
    };
    return {
        wrap: async (command, targets) => {
            const at = await ready();
            const spec = join(at, `${randomUUID()}.json`);
            await writeFile(spec, JSON.stringify({ command, targets }), { mode: 0o600, flag: "wx" });
            // `node` by name, as Cursor's hook script runs: guaranteed in the image, and the same binary inside a turn's
            // namespace as outside it.
            return `node ${shellQuote(join(at, SCRIPT_NAME))} ${shellQuote(spec)}`;
        },
        dispose: async () => {
            if (dir !== undefined) {
                // allow(silent-catch): the run has already settled; a temp dir it cannot remove (owner-only, 0700) must not fail it after the fact.
                await rm(await dir, { recursive: true, force: true }).catch(() => undefined);
            }
        },
    };
};
