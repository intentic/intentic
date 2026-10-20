#!/usr/bin/env node
// Writes the app's colours from the web editor's own: every semantic role semantic-colors.css declares
// (`--color-<role>: var(--role-<role>)`), evaluated in the light scheme into res/values/colors.xml and in the dark one
// into res/values-night/colors.xml. With `--check` it writes nothing and fails when either file is stale.
//
//   node _editor/android-app/scripts/theme.mjs [--check]
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { repoRoot } from "../../../_tools/constants/src/node.mjs";
import { roleColours } from "./lib/roles.mjs";
import { banner, emit } from "./lib/generated.mjs";

const root = repoRoot(import.meta.url);
const app = resolve(import.meta.dirname, `..`);
const styles = join(root, `_editor/ui/src/styles`);
const SOURCE = `_editor/ui/src/styles/semantic-colors.css`;

const read = (name) => readFileSync(join(styles, name), `utf8`);
const schemes = roleColours(read(`primitive-colors.css`), read(`semantic-colors.css`));

const xml = (colours) =>
    [
        `<?xml version="1.0" encoding="utf-8"?>`,
        banner(`theme.mjs`, SOURCE),
        `<resources>`,
        ...colours.map(([name, value]) => `    <color name="${name}">${value}</color>`),
        `</resources>`,
        ``,
    ].join(`\n`);

const res = join(app, `app/src/main/res`);
process.exitCode = emit(
    new Map([
        [join(res, `values/colors.xml`), xml(schemes.light)],
        [join(res, `values-night/colors.xml`), xml(schemes.dark)],
    ]),
    { check: process.argv.includes(`--check`), command: `node _editor/android-app/scripts/theme.mjs`, root },
);
