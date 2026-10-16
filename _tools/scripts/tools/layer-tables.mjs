// A PACKAGE'S LAYOUT TABLE, drawn from its layers.json. A package whose imports are layered (the daemon, the web editor)
// declares its layers once in layers.json, which its boundary check enforces; its README shows them as a table between
// two marker lines:
//
//   <!-- >>> generated from layers.json: edit it there, then run node _tools/checks/layer-tables.mjs --fix -->
//   <!-- <<< end of generated layers.json -->
//
// This fills that region: one row per layer, lowest first (its name, its `about`, its units), and a last row for the
// directories under the layers' root that no unit claims. The `layer-tables` check fails when a region is stale, and
// `--fix` rewrites it. Plain file reading, no network.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { repoRoot } from "../../constants/src/node.mjs";

export const root = repoRoot(import.meta.url);

export const OPEN = "<!-- >>> generated from layers.json: edit it there, then run node _tools/checks/layer-tables.mjs --fix -->";
export const CLOSE = "<!-- <<< end of generated layers.json -->";

// Directories the walk never enters: build output and dependency trees declare no layers of this repository's.
const SKIP = new Set(["node_modules", "dist", "target", "generated", ".cache", ".turbo", "out-tsc", ".git"]);
// A package sits at most this deep below its `_`-prefixed group.
const DEPTH = 4;

const walk = (dir, depth) =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
        if (entry.isDirectory()) {
            return SKIP.has(entry.name) || entry.name.startsWith(".") || depth >= DEPTH ? [] : walk(join(dir, entry.name), depth + 1);
        }
        return entry.name === "layers.json" ? [dir] : [];
    });

// Every package directory holding a layers.json, repo-relative.
export const layeredPackages = () =>
    readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("_"))
        .flatMap((entry) => walk(entry.name, 1))
        .toSorted();

const isDirectory = (path) => existsSync(path) && statSync(path).isDirectory();

const cell = (text) => text.replaceAll("|", "\\|").replaceAll("<", "&lt;");

// The table for one package's declared layers, `src` the absolute directory its units are relative to.
export const renderTable = (declared, src) => {
    const units = declared.layers.flatMap((layer) => layer.units);
    const shown = (unit) => (isDirectory(join(src, unit)) ? `\`${unit}/\`` : `\`${unit}\``);
    const rows = declared.layers.map((layer) => `| ${layer.name} | ${cell(layer.about ?? "")} | ${layer.units.map(shown).join(" ")} |`);
    const claimed = (name) => units.some((unit) => unit === name || unit.startsWith(`${name}/`));
    const unplaced = isDirectory(src)
        ? readdirSync(src, { withFileTypes: true })
              .filter((entry) => entry.isDirectory() && !claimed(entry.name))
              .map((entry) => `\`${entry.name}/\``)
              .toSorted()
        : [];
    if (unplaced.length > 0) {
        rows.push(`| (none) | in no layer: the boundary check places no module here | ${unplaced.join(" ")} |`);
    }
    return ["| Layer | Holds | Directories |", "| --- | --- | --- |", ...rows].join("\n");
};

// The README as it should be, with every marked region filled. Problems are what --fix cannot mend.
export const render = (file, text, table) => {
    const problems = [];
    const lines = text.split("\n");
    const out = [];
    for (let at = 0; at < lines.length; at++) {
        if (lines[at] !== OPEN) {
            out.push(lines[at]);
            continue;
        }
        const close = lines.indexOf(CLOSE, at + 1);
        if (close === -1) {
            problems.push(`${file}:${at + 1} opens a generated layers.json region and never closes it (${CLOSE})`);
            out.push(...lines.slice(at));
            break;
        }
        out.push(OPEN, table, CLOSE);
        at = close;
    }
    return { text: out.join("\n"), problems };
};

// Every package's README that carries a marked region: [{ file, path, stale, problems, text }]. A README without the
// markers is the package's own choice and is left alone.
export const readTables = () =>
    layeredPackages().flatMap((dir) => {
        const path = join(root, dir, "README.md");
        if (!existsSync(path)) {
            return [];
        }
        const now = readFileSync(path, "utf8");
        if (!now.split("\n").includes(OPEN)) {
            return [];
        }
        const file = relative(root, path);
        const declared = JSON.parse(readFileSync(join(root, dir, "layers.json"), "utf8"));
        const { text, problems } = render(file, now, renderTable(declared, join(root, dir, declared.root ?? "src")));
        return [{ file, path, stale: text !== now, problems, text }];
    });

export const writeTables = () => {
    const written = [];
    for (const table of readTables()) {
        if (table.stale && table.problems.length === 0) {
            writeFileSync(table.path, table.text);
            written.push(table.file);
        }
    }
    return written;
};

// Whether a change to `path` (relative to `checkout`) can move a generated table: a layers.json, or a README beside one.
export const touchesTables = (checkout, path) =>
    path.endsWith("layers.json") || (path.endsWith("README.md") && existsSync(join(checkout, dirname(path), "layers.json")));

if (import.meta.url === `file://${process.argv[1]}`) {
    const written = writeTables();
    console.log(written.length === 0 ? "layer-tables: every generated table is current" : `layer-tables: rewrote ${written.join(", ")}`);
}
