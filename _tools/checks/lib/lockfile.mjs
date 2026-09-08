// Reads pnpm-lock.yaml and the catalogs with a line scanner, not a YAML parser, since these checks run before `pnpm
// install`. Indentation (2/4/6/8) is the grammar; each level's anchor keeps them mutually exclusive, and a shape the
// scanner stops recognizing appears as an empty region, reported as drift.
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
// The line below `specifier:`: what it resolved to, the reachability walk's starting point.
const VERSION = /^ {8}version:[ \t]*(.*?)[ \t]*$/;

// Lines of one column-0 region, from its key to the next column-0 line, blanks included.
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

// Reads `importers:` as importer -> block -> { name: specifier }, plus every `version:` an importer resolved.
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
                // `?.`: a level without its parent means the shape moved; the empty result is reported as drift, not a
                // crash.
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

// Reads `catalogs:` as catalog name -> { dependency: specifier }: the same catalogs `--frozen-lockfile` compares
// against pnpm-workspace.yaml. One level deeper than the manifest; the specifier is the comparable half.
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

// Reads `snapshots:` as package id -> [package id], from each entry's `dependencies:`/`optionalDependencies:` edges
// (including pnpm's alias form). `link:` targets are dropped; `file:` ones are kept, via idOf.
const readSnapshots = (lines) => {
    const edges = new Map();
    let snapshot, group;
    for (const line of region(lines, "snapshots")) {
        if (!line.trim()) {
            continue;
        }
        // 2 spaces is a package id, 4 a dependency group, 6 an edge: one region down from the same grammar.
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

// What `readLockfile` returns:
// recorded importer -> block -> { name: specifier }
// installed [name, version] pairs, the reachability roots
// catalogued catalog name -> { dependency: specifier }
// edges package id -> [package id]
export const readLockfile = () => {
    const lines = readFileSync(join(root, "pnpm-lock.yaml"), "utf8").split("\n");
    return { ...readImporters(lines), catalogued: readCatalogued(lines), edges: readSnapshots(lines) };
};

// Reads `packageManagerDependencies:` as package -> version: which pnpm the lockfile pins. A separate pass, since pnpm
// 12 writes this pin in a `---`-separated document ahead of the real lockfile that `readImporters` would otherwise
// overwrite.
export const readPackageManagerPin = () => {
    const pinned = new Map();
    let inside = false;
    let entry;
    for (const line of readFileSync(join(root, "pnpm-lock.yaml"), "utf8").split("\n")) {
        if (/^ {0,4}\S/.test(line)) {
            inside = /^ {4}packageManagerDependencies:[ \t]*$/.test(line);
            continue;
        }
        const named = /^ {6}(\S.*?):[ \t]*$/.exec(line);
        if (inside && named) {
            entry = unquote(named[1]);
            continue;
        }
        const version = /^ {8}version:[ \t]*(.*?)[ \t]*$/.exec(line);
        if (inside && version && entry !== undefined) {
            pinned.set(entry, unquote(version[1]));
        }
    }
    return pinned;
};

// The catalogs pnpm-workspace.yaml declares, catalog name -> { dependency: version }. Same scanner: `catalog:` at
// column 0 is the default catalog, `catalogs:` is a level of named ones above it.
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
        // A 2-space key with no value inside `catalogs:` names the catalog the 4-space entries below belong to.
        if (catalogName === "" || (mapping[2] === "" && /^ {2}\S/.test(line))) {
            catalogName = unquote(mapping[1]);
            catalogs.set(catalogName, new Map());
            continue;
        }
        catalogs.get(catalogName).set(unquote(mapping[1]), unquote(mapping[2]));
    }
    return catalogs;
};
