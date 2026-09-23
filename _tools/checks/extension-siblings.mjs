#!/usr/bin/env node
// Only the listed standalone extension repos may live under the workspace's extensions/.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { finish } from "./lib/report.mjs";
import { repoRoot } from "../constants/src/node.mjs";

const ALLOWED = new Set([`logs`, `scrub`, `intentic-saldeo`]);

const extensionsDir = join(repoRoot(import.meta.url), `..`, `extensions`);
if (!existsSync(extensionsDir)) {
    console.log(`extension-siblings: no workspace extensions/ beside intentic`);
    process.exit(0);
}

const present = readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(`.`))
    .map((entry) => entry.name);

const stale = present.filter((name) => !ALLOWED.has(name));
finish(
    [[`these directories under extensions/ are not allowed`, stale.map((name) => `${name}/ — rm -rf extensions/${name}`)]],
    [`extensions/: ${present.length} director${present.length === 1 ? `y` : `ies`}, each allowed`],
);
