// The other half of heavy-hook.cjs, for programs that are not node scripts (pnpm's own binary, bun, cargo): a thin
// wrapper of that name, first on the agent's PATH (_sandbox/sandbox/bin/heavy-shims), runs
// `node heavy-exec.cjs <wrapper dir> <program> <args…>`. The program is the one its wrapper stands for, its arguments
// are the ones it was given; heavy-turn.cjs judges them, and then this process becomes the real program, found on the
// PATH past the wrappers.
"use strict";

const { accessSync, constants } = require("node:fs");
const { delimiter, join, resolve } = require("node:path");
const { takeTurn } = require("./heavy-turn.cjs");

const [shims = "", program = "", ...args] = process.argv.slice(2);

// The real program: the first executable of that name on the PATH that is not a wrapper. The PATH it runs with keeps the
// wrappers, so a program it starts in turn (a package script's `bun test`) is judged the same way.
const pathEntries = (process.env.PATH ?? "").split(delimiter).filter((entry) => entry !== "" && resolve(entry) !== resolve(shims));
const real = pathEntries
    .map((entry) => join(entry, program))
    .find((candidate) => {
        try {
            accessSync(candidate, constants.X_OK);
            return true;
        } catch {
            // allow(silent-catch): absent or not executable is exactly "not this one"
            return false;
        }
    });

if (real === undefined) {
    process.stderr.write(`${program}: command not found\n`);
    process.exit(127);
}
try {
    takeTurn({ program, args, command: [real, ...args] });
} catch {
    // allow(silent-catch): a table that does not parse runs the program as if unjudged
}
// `real` passed the executable check above, so this execve does not fail the way that aborts a process.
if (typeof process.execve === "function") {
    process.execve(real, [program, ...args], process.env);
}
const { spawnSync } = require("node:child_process");
const run = spawnSync(real, args, { stdio: "inherit", env: process.env, argv0: program });
process.exit(run.status ?? 1);
