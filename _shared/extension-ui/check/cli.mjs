#!/usr/bin/env node
// `intentic-kit-check [dir]`: what an extension must change for the kit and API it builds against (check/extension.mjs),
// run from the extension's own repository, where the intentic repository's checks never reach. Reads the extension's
// `src/` and `intentic-extension.json`, and the surface record of the @intentic/extension-api it has installed. Exits 1
// with one `path:line  why` per finding, so an author's typecheck fails where the host would otherwise refuse or the
// look would drift. A finding that is right to keep says so in place: `allow(kit-check): <reason>`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { extensionFindings } from "./extension.mjs";

const root = resolve(process.argv[2] ?? `.`);
const SOURCE = /\.(?:vue|ts|mts|js|mjs)$/u;
const SKIPPED = /\.(?:test|spec)\.\w+$|\.d\.m?ts$/u;

const files = [];
const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== `node_modules` && entry.name !== `dist` && !entry.name.startsWith(`.`)) {
                walk(full);
            }
        } else if (SOURCE.test(entry.name) && !SKIPPED.test(entry.name)) {
            files.push({ path: relative(root, full).replaceAll(`\\`, `/`), text: readFileSync(full, `utf8`) });
        }
    }
};

const manifestPath = join(root, `intentic-extension.json`);
if (!existsSync(manifestPath) || !existsSync(join(root, `src`))) {
    console.error(`intentic-kit-check: ${root} is not an extension (no intentic-extension.json beside a src/)`);
    process.exit(2);
}
walk(join(root, `src`));

// The API this extension builds against, as installed beside it: its record of every version's surface.
// Undefined only when no extension-api that exports the record is installed; anything else is a real failure.
const NOT_INSTALLED = new Set([`MODULE_NOT_FOUND`, `ERR_MODULE_NOT_FOUND`, `ERR_PACKAGE_PATH_NOT_EXPORTED`]);
const surfaceOf = () => {
    let path;
    try {
        path = createRequire(join(root, `package.json`)).resolve(`@intentic/extension-api/surface.json`);
    } catch (error) {
        if (NOT_INSTALLED.has(error?.code)) {
            return undefined;
        }
        throw error;
    }
    return JSON.parse(readFileSync(path, `utf8`));
};

const findings = extensionFindings({ files, manifest: JSON.parse(readFileSync(manifestPath, `utf8`)), surface: surfaceOf() });
if (findings.length > 0) {
    for (const { at, why } of findings) {
        console.error(`${at}  ${why}`);
    }
    console.error(`\nintentic-kit-check: ${findings.length} problem(s) in what this extension takes from the kit`);
    process.exit(1);
}
console.log(`intentic-kit-check: ${files.length} source files use the kit as it stands, within what engines.intentic promises`);
