// Pins the glibc floor gate's reading of its two inputs (the floor from tauri.conf.json and the symbol versions
// from `objdump -T`) on canned text, and the real config's floor being one the gate can read at all.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
    compareVersions,
    DEFAULT_CONFIG,
    declaredFloor,
    dynamicSymbols,
    glibcImports,
    newestImport,
    packageFloorProblems,
    rpmRequirement,
    violations,
} from "./glibc-floor.mjs";

// Abridged from `objdump -T` on a trixie build: binutils 2.44 parenthesises the version of an import, and a
// library's own definitions carry a bare version with no *UND*.
const APP = `
target/release/intentic-desktop:     file format elf64-x86-64

DYNAMIC SYMBOL TABLE:
0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.2.5) malloc
0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.34) __libc_start_main
0000000000000000  w   DF *UND*\t0000000000000000 (GLIBC_2.39) pidfd_spawnp
0000000000000000  w   D  *UND*\t0000000000000000  Base        __gmon_start__
`;
const NEWER = `
0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.41) sched_setattr
0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.38) __isoc23_strtol
`;
// A glibc library DEFINES versions newer than any floor; only imports count.
const DEFINES = `
00000000000a1b20 g    DF .text\t0000000000000025  GLIBC_2.41  sched_setattr
0000000000000000      DF *UND*\t0000000000000000 (GLIBC_PRIVATE) _dl_find_object
`;
// Older binutils print the version without parentheses.
const OLD_BINUTILS = "0000000000000000      DF *UND*\t0000000000000000  GLIBC_2.40  some_symbol\n";

const config = (deb, rpm) => ({ bundle: { linux: { deb: { depends: deb }, rpm: { depends: rpm } } } });

test("versions compare numerically, component by component", () => {
    assert.ok(compareVersions("2.39", "2.4") > 0);
    assert.ok(compareVersions("2.2.5", "2.39") < 0);
    assert.ok(compareVersions("2.39.1", "2.39") > 0);
    assert.equal(compareVersions("2.39", "2.39.0"), 0);
});

test("the floor is the deb's libc6 bound, and the rpm must name the same one", () => {
    assert.equal(declaredFloor(config(["libc6 (>= 2.39)"], [rpmRequirement("2.39")])), "2.39");
    assert.throws(() => declaredFloor(config([], [rpmRequirement("2.39")])), /exactly one "libc6 \(>= x\.y\)"/);
    assert.throws(() => declaredFloor(config(["libc6 (>= 2.39)"], [])), /libc\.so\.6\(GLIBC_2\.39\)\(64bit\)/);
    assert.throws(() => declaredFloor(config(["libc6 (>= 2.39)"], [rpmRequirement("2.38")])), /match the deb's libc6 \(>= 2\.39\)/);
});

test("the repository's own config declares a floor the gate can read", () => {
    const floor = declaredFloor(JSON.parse(readFileSync(DEFAULT_CONFIG, "utf8")));
    assert.match(floor, /^\d+\.\d+$/);
});

test("only imports count, in either binutils spelling", () => {
    assert.deepEqual(glibcImports(APP), [
        { version: "2.2.5", symbol: "malloc" },
        { version: "2.34", symbol: "__libc_start_main" },
        { version: "2.39", symbol: "pidfd_spawnp" },
    ]);
    assert.deepEqual(glibcImports(DEFINES), []);
    assert.deepEqual(glibcImports(OLD_BINUTILS), [{ version: "2.40", symbol: "some_symbol" }]);
});

test("an import at the floor passes, and one above it names its file and symbol", () => {
    const files = [
        { path: "usr/bin/intentic-desktop", objdump: APP },
        { path: "usr/lib/libdefines.so", objdump: DEFINES },
    ];
    assert.deepEqual(violations(files, "2.39"), []);
    assert.equal(newestImport(files), "2.39");
    assert.deepEqual(violations([...files, { path: "usr/lib/libnewer.so.1", objdump: NEWER }], "2.39"), [
        { path: "usr/lib/libnewer.so.1", version: "2.41", symbol: "sched_setattr" },
    ]);
    assert.deepEqual(
        violations([{ path: "usr/bin/intentic-desktop", objdump: APP }], "2.34").map((found) => found.symbol),
        ["pidfd_spawnp"],
    );
});

test("the built package's metadata must carry the floor the config declares", () => {
    const depends = "libc6 (>= 2.39), libwebkit2gtk-4.1-0, libgtk-3-0, libayatana-appindicator3-1";
    assert.deepEqual(packageFloorProblems("deb", depends, "2.39"), []);
    assert.deepEqual(packageFloorProblems("deb", "libwebkit2gtk-4.1-0, libgtk-3-0", "2.39"), [
        "Depends names no libc6 floor (Depends: libwebkit2gtk-4.1-0, libgtk-3-0)",
    ]);
    assert.deepEqual(packageFloorProblems("deb", "libc6 (>= 2.36), libgtk-3-0", "2.39"), ["Depends says libc6 (>= 2.36), the config says 2.39"]);
    const requires = "libc.so.6(GLIBC_2.39)(64bit)\nlibwebkit2gtk-4.1.so.0()(64bit)\nlibgtk-3.so.0()(64bit)\n";
    assert.deepEqual(packageFloorProblems("rpm", requires, "2.39"), []);
    assert.deepEqual(packageFloorProblems("rpm", "libgtk-3.so.0()(64bit)\n", "2.39"), ["Requires lacks libc.so.6(GLIBC_2.39)(64bit)"]);
});

test("a statically linked ELF imports nothing, and any other objdump failure is still one", () => {
    // What objdump 2.44 does with build-ic.sh's static musl ic, bundled as intentic-ic: the banner on stdout, this on
    // stderr, exit 1.
    const failing = (stderr) => () => {
        throw Object.assign(new Error("Command failed: objdump -T usr/bin/intentic-ic"), { status: 1, stderr });
    };
    assert.equal(dynamicSymbols("usr/bin/intentic-ic", failing("objdump: usr/bin/intentic-ic: not a dynamic object\n")), "");
    assert.deepEqual(glibcImports(dynamicSymbols("usr/bin/intentic-ic", failing("objdump: usr/bin/intentic-ic: not a dynamic object\n"))), []);
    assert.throws(
        () => dynamicSymbols("usr/bin/intentic-ic", failing("objdump: usr/bin/intentic-ic: file format not recognized\n")),
        /Command failed/,
    );
    assert.equal(
        dynamicSymbols("app", () => APP),
        APP,
    );
});
