/* pnpm-lock.yaml AND THE CATALOGS, read with a line scanner rather than a YAML parser on purpose: these checks
 * run BEFORE `pnpm install`, so they cannot import one. The indentation IS the grammar here (2/4/6/8), and each
 * level's anchor makes the levels mutually exclusive, so a line is read as exactly one of importer, block,
 * entry, specifier or version. A shape the scanner stops recognizing shows up as an empty region, which the
 * checks report as drift rather than passing in silence. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./repo.mjs";

export const unquote = (value) => (/^'.*'$/s.test(value) ? value.slice(1, -1).replaceAll("''", "'") : /^".*"$/s.test(value) ? value.slice(1, -1) : value);

const LEVELS = [
    { depth: 2, of: "importer" },
    { depth: 4, of: "block" },
    { depth: 6, of: "entry" },
];
const SPECIFIER = /^ {8}specifier:[ \t]*(.*?)[ \t]*$/;
// The line under it: what that specifier RESOLVED to, which is where the reachability walk starts.
const VERSION = /^ {8}version:[ \t]*(.*?)[ \t]*$/;

// The lines of one column-0 region: from its key to the next column-0 line, blank lines included.
const region = (lines, name) => {
    const found = [];
    let inside = false;
    for (const line of lines) {
        if (/^\S/.test(line)) {
            inside = line.startsWith(`${name}:`);
            continue;
        }
        if (inside) {
            found.push(line);
        }
    }
    return found;
};

// `importers:` as importer -> block -> { name: specifier }, plus every `version:` an importer resolved.
const readImporters = (lines) => {
    const recorded = new Map();
    const installed = [];
    let currentImporter, section, entry;
    for (const line of region(lines, "importers")) {
        const level = LEVELS.find(({ depth }) => new RegExp(String.raw`^ {${depth}}\S`).test(line));
        const key = level && new RegExp(String.raw`^ {${level.depth}}(\S.*?):[ \t]*$`).exec(line);
        if (key) {
            const name = unquote(key[1]);
            if (level.of === "importer") {
                currentImporter = name;
                recorded.set(currentImporter, new Map());
            } else if (level.of === "block") {
                section = name;
                // `?.` here and below: a level arriving without its parent means the shape moved, and the empty
                // `recorded` that leaves is reported as drift by the size check, which a stack trace would not be.
                recorded.get(currentImporter)?.set(section, new Map());
            } else {
                entry = name;
            }
            continue;
        }
        const specifier = SPECIFIER.exec(line);
        if (specifier) {
            recorded.get(currentImporter)?.get(section)?.set(entry, unquote(specifier[1]));
        }
        const version = VERSION.exec(line);
        if (version) {
            installed.push([entry, unquote(version[1])]);
        }
    }
    return { recorded, installed };
};

/* `catalogs:` as catalog name -> { dependency: specifier }: THE SAME CATALOGS AS THE LOCKFILE RECORDED THEM, a
 * second copy of the manifest and therefore a second thing that can go stale. pnpm snapshots every catalog
 * entry an importer resolved through, and `--frozen-lockfile` compares pnpm-workspace.yaml against THAT. One
 * level deeper than the manifest's: the catalog's name at 2, a dependency at 4, its `specifier:`/`version:`
 * pair at 6. The SPECIFIER is the comparable half. */
const readCatalogued = (lines) => {
    const catalogued = new Map();
    let recordedCatalog, cataloguedEntry;
    for (const line of region(lines, "catalogs")) {
        const named = /^ {2}(\S.*?):[ \t]*$/.exec(line);
        if (named) {
            recordedCatalog = unquote(named[1]);
            catalogued.set(recordedCatalog, new Map());
            continue;
        }
        const dependency = /^ {4}(\S.*?):[ \t]*$/.exec(line);
        if (dependency) {
            cataloguedEntry = unquote(dependency[1]);
            continue;
        }
        const pinned = /^ {6}specifier:[ \t]*(.*?)[ \t]*$/.exec(line);
        if (pinned) {
            catalogued.get(recordedCatalog)?.set(cataloguedEntry, unquote(pinned[1]));
        }
    }
    return catalogued;
};

export const idOf = (name, value) => (value.startsWith("link:") ? undefined : value.startsWith("file:") || /^\d/.test(value) ? `${name}@${value}` : value);

/* `snapshots:` as a graph, package id -> [package id]. Edges are each snapshot's `dependencies:` and
 * `optionalDependencies:`, whose values are versions of the key beside them: except when they name a package
 * outright, which is how pnpm writes an alias (`'@openai/codex-linux-x64': '@openai/codex@0.147.0-linux-x64'`).
 * A leading digit is the whole difference, and `file:` (an injected workspace package, which does get an
 * entry) parts company with `link:` (a symlinked one, which does not). */
const readSnapshots = (lines) => {
    const edges = new Map();
    let snapshot, group;
    for (const line of region(lines, "snapshots")) {
        if (!line.trim()) {
            continue;
        }
        // 2 spaces is a package id, 4 a dependency group, 6 an edge: the same grammar, one region down.
        const id = /^ {2}(\S.*?):(?: \{\})?[ \t]*$/.exec(line);
        if (id) {
            snapshot = unquote(id[1]);
            edges.set(snapshot, []);
            continue;
        }
        if (/^ {4}\S/.test(line)) {
            group = line.trim().replace(/:$/, "");
            continue;
        }
        const edge = group === "dependencies" || group === "optionalDependencies" ? /^ {6}(\S.*?):[ \t]*(.*?)[ \t]*$/.exec(line) : null;
        const to = edge && idOf(unquote(edge[1]), unquote(edge[2]));
        if (to) {
            edges.get(snapshot)?.push(to);
        }
    }
    return edges;
};

/* The lockfile's three regions:
 *   recorded    importer -> block -> { name: specifier }
 *   installed   [name, version] for every `version:` an importer resolved, the reachability roots
 *   catalogued  catalog name -> { dependency: specifier }
 *   edges       package id -> [package id] */
export const readLockfile = () => {
    const lines = readFileSync(join(root, "pnpm-lock.yaml"), "utf8").split("\n");
    return { ...readImporters(lines), catalogued: readCatalogued(lines), edges: readSnapshots(lines) };
};

/* The catalogs pnpm-workspace.yaml declares, as `catalog name -> { dependency: version }`. Same flat shape,
 * same scanner: `catalog:` at column 0 is the default catalog's entries, `catalogs:` is a level of named ones
 * above them. */
export const readCatalogs = () => {
    const catalogs = new Map([["default", new Map()]]);
    let catalogName;
    for (const line of readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").split("\n")) {
        if (/^\S/.test(line)) {
            catalogName = line.startsWith("catalog:") ? "default" : line.startsWith("catalogs:") ? "" : undefined;
            continue;
        }
        if (catalogName === undefined || /^\s*(#|$)/.test(line)) {
            continue;
        }
        const mapping = /^ {2}(\S.*?):[ \t]*(.*?)[ \t]*$/.exec(line) ?? /^ {4}(\S.*?):[ \t]*(.*?)[ \t]*$/.exec(line);
        if (mapping === null) {
            continue;
        }
        // A 2-space key with no value inside `catalogs:` names the catalog the 4-space entries below it belong to.
        if (catalogName === "" || (mapping[2] === "" && /^ {2}\S/.test(line))) {
            catalogName = unquote(mapping[1]);
            catalogs.set(catalogName, new Map());
            continue;
        }
        catalogs.get(catalogName).set(unquote(mapping[1]), unquote(mapping[2]));
    }
    return catalogs;
};
