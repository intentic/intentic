#!/usr/bin/env node
// The install scripts' generated regions (the output kit, the ic and intentic-machine downloads, the PATH edit, the code
// redemption) read back exactly their one source under _site/site/scripts-kit/. A hand edit inside a region, or a
// source changed without regenerating, is caught here; `--fix` rewrites the stale regions in place
// (_tools/scripts/tools/scripts-kit.mjs owns the reading and writing). Plain file reading: no install, no network.

import { readScripts, writeScripts, SCRIPTS_DIR } from "../scripts/tools/scripts-kit.mjs";
import { finish } from "./lib/report.mjs";

if (process.argv.includes("--fix")) {
    for (const file of writeScripts()) {
        console.log(`rewrote ${SCRIPTS_DIR}/${file}`);
    }
}

const scripts = readScripts();
const problems = scripts.flatMap((script) => script.problems);
const stale = scripts
    .filter((script) => script.stale && script.problems.length === 0)
    .map((script) => `${SCRIPTS_DIR}/${script.file} (run node _tools/checks/scripts-kit.mjs --fix)`);

finish(
    [
        ["an install script's generated region is out of date", stale],
        ["an install script's generated regions cannot be filled", problems],
    ],
    [`scripts kit: ${scripts.length} install scripts carry their generated regions as their sources say`],
);
