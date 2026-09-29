#!/usr/bin/env node
// THE GLIBC FLOOR, held to what the Linux bundle actually links against.
//
//   glibc-floor.mjs [--config <tauri.conf.json>] <label> <payload dir> [<package .deb|.rpm>]
//
// A glibc symbol is versioned, so a binary linked on a newer glibc asks for GLIBC_x.y and dies in the loader on
// an older one ("version `GLIBC_2.39' not found") after the package has installed cleanly. The floor is declared
// ONCE, as the deb's `libc6 (>= x.y)` in _editor/desktop-app/src-tauri/tauri.conf.json. The rpm's
// `libc.so.6(GLIBC_x.y)(64bit)` must name the same version, and the download page and the desktop-app README
// repeat it for people. This fails when:
//
//   - any ELF in the payload (the app, its sidecar, every library an AppImage vendors) imports a GLIBC_ symbol
//     version newer than the floor, which is what happens silently when the build base moves to a newer Debian;
//   - the rpm's declared floor is not the deb's;
//   - the built package does not carry the floor in its metadata, which only the bundler can get wrong.
//
// Runs from verify-desktop-bundle.sh over each extracted payload, and by hand over any directory of ELFs.
import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_CONFIG = fileURLToPath(new URL("../../../_editor/desktop-app/src-tauri/tauri.conf.json", import.meta.url));

const DEB_FLOOR = /^libc6\s*\(>=\s*(\d+(?:\.\d+)+)\)$/;

/** "2.39" < "2.39.1" < "2.40": numeric, component by component. */
export function compareVersions(a, b) {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
        const delta = (left[index] ?? 0) - (right[index] ?? 0);
        if (delta !== 0) {return delta;}
    }
    return 0;
}

/** The rpm capability glibc provides for a symbol version: what rpmbuild itself would have generated. */
export function rpmRequirement(floor) {
    return `libc.so.6(GLIBC_${floor})(64bit)`;
}

/** The declared floor, read from the deb's depends and cross-checked against the rpm's. Throws on either gap. */
export function declaredFloor(config) {
    const linux = config?.bundle?.linux ?? {};
    const debDepends = linux.deb?.depends ?? [];
    const floors = debDepends.map((entry) => DEB_FLOOR.exec(entry.trim())?.[1]).filter(Boolean);
    if (floors.length !== 1) {
        throw new Error(`bundle.linux.deb.depends must name exactly one "libc6 (>= x.y)" floor, found ${JSON.stringify(debDepends)}`);
    }
    const floor = floors[0];
    const rpmDepends = linux.rpm?.depends ?? [];
    if (!rpmDepends.includes(rpmRequirement(floor))) {
        throw new Error(
            `bundle.linux.rpm.depends must carry "${rpmRequirement(floor)}" to match the deb's libc6 (>= ${floor}), found ${JSON.stringify(rpmDepends)}`,
        );
    }
    return floor;
}

/** Every GLIBC_ version an `objdump -T` listing IMPORTS, with the symbol that asks for it. Definitions are skipped. */
export function glibcImports(objdumpText) {
    const imports = [];
    for (const line of objdumpText.split("\n")) {
        if (!line.includes("*UND*")) {continue;}
        const match = /\(?GLIBC_(\d+(?:\.\d+)+)\)?\s+(\S+)\s*$/.exec(line);
        if (match) {imports.push({ version: match[1], symbol: match[2] });}
    }
    return imports;
}

/** The imports above the floor, per file, newest first. `files` is [{ path, objdump }]. */
export function violations(files, floor) {
    const found = [];
    for (const { path, objdump } of files) {
        for (const { version, symbol } of glibcImports(objdump)) {
            if (compareVersions(version, floor) > 0) {found.push({ path, version, symbol });}
        }
    }
    return found.sort((a, b) => compareVersions(b.version, a.version) || a.path.localeCompare(b.path));
}

/** The newest GLIBC_ version any file imports, or null when none imports one. */
export function newestImport(files) {
    let newest = null;
    for (const { objdump } of files) {
        for (const { version } of glibcImports(objdump)) {
            if (newest === null || compareVersions(version, newest) > 0) {newest = version;}
        }
    }
    return newest;
}

/** Problems with the floor as the built package's own metadata states it. */
export function packageFloorProblems(kind, metadata, floor) {
    if (kind === "deb") {
        const entries = metadata.split(",").map((entry) => entry.trim());
        const declared = entries.map((entry) => DEB_FLOOR.exec(entry)?.[1]).filter(Boolean);
        if (declared.length === 0) {return [`Depends names no libc6 floor (Depends: ${metadata.trim() || "empty"})`];}
        return declared.filter((version) => version !== floor).map((version) => `Depends says libc6 (>= ${version}), the config says ${floor}`);
    }
    const requires = metadata.split("\n").map((line) => line.trim());
    return requires.includes(rpmRequirement(floor)) ? [] : [`Requires lacks ${rpmRequirement(floor)}`];
}

function isElf(path) {
    const fd = openSync(path, "r");
    try {
        const magic = Buffer.alloc(4);
        return readSync(fd, magic, 0, 4, 0) === 4 && magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    } finally {
        closeSync(fd);
    }
}

/** Regular files only: a symlink points at a file the walk reaches on its own, or outside the payload. */
function elfFiles(dir) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {found.push(...elfFiles(path));}
        else if (entry.isFile() && lstatSync(path).size >= 4 && isElf(path)) {found.push(path);}
    }
    return found;
}

const run = (command, args) => execFileSync(command, args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

function packageMetadata(pkg) {
    if (pkg.endsWith(".deb")) {return { kind: "deb", text: run("dpkg-deb", ["-f", pkg, "Depends"]) };}
    if (pkg.endsWith(".rpm")) {return { kind: "rpm", text: run("rpm", ["-qp", "--requires", pkg]) };}
    throw new Error(`not a .deb or .rpm: ${pkg}`);
}

function parseArgs(argv) {
    const args = [...argv];
    let config = DEFAULT_CONFIG;
    const at = args.indexOf("--config");
    if (at !== -1) {
        config = args[at + 1];
        args.splice(at, 2);
    }
    const [label, dir, pkg] = args;
    if (!label || !dir) {
        throw new Error("usage: glibc-floor.mjs [--config <tauri.conf.json>] <label> <payload dir> [<package .deb|.rpm>]");
    }
    return { config, label, dir, pkg };
}

function main(argv) {
    const { config, label, dir, pkg } = parseArgs(argv);
    const floor = declaredFloor(JSON.parse(readFileSync(config, "utf8")));
    const files = elfFiles(dir).map((path) => ({ path: relative(dir, path), objdump: run("objdump", ["-T", path]) }));
    const problems = violations(files, floor).map(({ path, version, symbol }) => `${path} needs GLIBC_${version} for ${symbol}`);
    if (pkg) {
        const { kind, text } = packageMetadata(pkg);
        problems.push(...packageFloorProblems(kind, text, floor));
    }
    if (files.length === 0) {problems.push("no ELF files in the payload, so the floor was checked against nothing");}
    if (problems.length > 0) {
        for (const problem of problems) {console.error(`  ✗ ${label}: ${problem} (declared floor: glibc ${floor})`);}
        console.error(
            "    a newer import means the build base moved: raise both floors in tauri.conf.json and the releases the download page and _editor/desktop-app/README.md name, or link on an older base",
        );
        return 1;
    }
    const newest = newestImport(files);
    const slack = newest && compareVersions(newest, floor) < 0 ? `; the build needs only GLIBC_${newest}, so the floor could come down` : "";
    console.log(`  ✓ ${label}: ${files.length} ELF file(s) need at most GLIBC_${newest ?? "none"}, within the declared glibc ${floor}${slack}`);
    return 0;
}

if (process.argv[1] === import.meta.filename) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (error) {
        console.error(`error: ${error.message}`);
        process.exitCode = 2;
    }
}
