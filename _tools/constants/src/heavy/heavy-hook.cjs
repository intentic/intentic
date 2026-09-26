// Loaded into every node program an agent's command starts (`NODE_OPTIONS=--require …/heavy-hook.cjs`, set by the
// daemon, _sandbox/sandbox/src/agent/tools/agent-terminals.ts), so the heavy-command queue follows the program that
// actually runs — `vitest` under `pnpm test`, `tsc` under a `make` target, `turbo` under an npm script — and not the words
// an agent typed. The program is the script node was asked to run, named as its package publishes it (`vitest`, `tsc`,
// `npx`); heavy-turn.cjs decides the rest. Nothing here may be why a program did not run.
"use strict";

const { readFileSync, realpathSync } = require("node:fs");
const { basename, dirname, join, resolve } = require("node:path");

// The command a script is published as: the `bin` entry of its nearest package.json that names this very file, else its
// own file name without its extension.
const programOf = (script) => {
    let real = script;
    try {
        real = realpathSync(script);
    } catch {
        // allow(silent-catch): a script path that does not resolve is named by what it says
    }
    let dir = dirname(real);
    for (let depth = 0; depth < 6; depth += 1) {
        let manifest;
        try {
            manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        } catch {
            // allow(silent-catch): a directory without a package.json (or with a broken one) names nothing; look further up
            manifest = undefined;
        }
        if (manifest !== undefined) {
            const name = typeof manifest.name === "string" ? manifest.name.split("/").pop() : undefined;
            const bins = typeof manifest.bin === "string" ? { [name ?? ""]: manifest.bin } : (manifest.bin ?? {});
            const named = Object.entries(bins).find(([, path]) => typeof path === "string" && resolve(dir, path) === real)?.[0];
            if (named !== undefined && named !== "") {
                return named;
            }
            break;
        }
        const up = dirname(dir);
        if (up === dir) {
            break;
        }
        dir = up;
    }
    return basename(real).replace(/\.[cm]?[jt]s$/u, "");
};

try {
    const script = process.argv[1];
    if (process.env.INTENTIC_HEAVY !== undefined && script !== undefined && script !== "") {
        const { takeTurn } = require("./heavy-turn.cjs");
        takeTurn({
            program: programOf(script),
            args: process.argv.slice(2),
            command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
        });
    }
} catch {
    // allow(silent-catch): a table that does not parse or a program that cannot be named runs as if unjudged
}

module.exports = { programOf };
