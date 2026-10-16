#!/usr/bin/env node
// A layered package's README table (the daemon's, the web editor's) reads back exactly its layers.json: a hand edit
// inside the generated region, or a layers.json or src/ directory changed without regenerating, is caught here; `--fix`
// rewrites the stale regions in place (_tools/scripts/tools/layer-tables.mjs owns the reading and writing).

import { readTables, writeTables } from "../scripts/tools/layer-tables.mjs";
import { finish } from "./lib/report.mjs";

if (process.argv.includes("--fix")) {
    for (const file of writeTables()) {
        console.log(`rewrote ${file}`);
    }
}

const tables = readTables();
const problems = tables.flatMap((table) => table.problems);
const stale = tables
    .filter((table) => table.stale && table.problems.length === 0)
    .map((table) => `${table.file} (run node _tools/checks/layer-tables.mjs --fix)`);

finish(
    [
        ["a README's generated layers table is out of date", stale],
        ["a README's generated layers table cannot be filled", problems],
    ],
    [`layer tables: ${tables.length} READMEs carry their layers.json as it stands`],
);
