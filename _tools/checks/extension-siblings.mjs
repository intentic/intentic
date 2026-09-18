#!/usr/bin/env node
// Showcase extension repos under workspace extensions/ were removed; only the listed siblings may remain.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { finish } from "./lib/report.mjs";
import { repoRoot } from "../constants/src/node.mjs";

const ALLOWED = new Set([`logs`, `scrub`, `intentic-saldeo`]);
const REMOVED = new Set([`contact-sheet`, `everyday-viewers`, `homelab`, `paperwork`, `feeds`]);

const extensionsDir = join(repoRoot(import.meta.url), `..`, `extensions`);
if (!existsSync(extensionsDir)) {
    console.log(`extension-siblings: no workspace extensions/ beside intentic`);
    process.exit(0);
}

const present = readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(`.`))
    .map((entry) => entry.name);

const stale = present.filter((name) => REMOVED.has(name) || !ALLOWED.has(name));
finish(
    [[`these directories under extensions/ were removed or are not allowed`, stale.map((name) => `${name}/ — rm -rf extensions/${name}`)]],
    [`extensions/: ${present.length} director${present.length === 1 ? `y` : `ies`}, each allowed`],
);
