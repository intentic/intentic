import { expect, test } from "vitest";
// @ts-expect-error -- hand-written .mjs with a .d.mts beside it; see mirror-roots.mjs for why it isn't compiled.
import { MIRRORED_DIRS, replacedMirrorRoots } from "./mirror-roots.mjs";

// Pins replacedMirrorRoots: which shell commands replace, rather than empty, a mirror root, across every shape used in
// this repo.

const PRISMA_BUILD = "rm -rf ./generated ./dist ./.cache && DATABASE_URL=postgresql://placeholder prisma generate --no-hints && tsgo";

test("the mirror roots are the installed trees and the build outputs a checkout cannot carry", () => {
    expect([...MIRRORED_DIRS].toSorted()).toEqual([".venv", "dist", "generated", "node_modules"]);
});

test("a python environment is a mirror root, so removing one outright is reported like any other", () => {
    expect(replacedMirrorRoots("rm -rf .venv && uv sync")).toEqual([".venv"]);
    expect(replacedMirrorRoots("rm -rf services/api/.venv")).toEqual(["services/api/.venv"]);
    expect(replacedMirrorRoots("find . -mindepth 1 -path '*/.venv/*' -delete")).toEqual([]);
    expect(replacedMirrorRoots("rm -rf venv env")).toEqual([]);
});

test("the removal that emptied every agent's prisma output is reported, and the cache beside it is not", () => {
    expect(replacedMirrorRoots(PRISMA_BUILD)).toEqual(["./generated", "./dist"]);
});

test("removing the CONTENTS of a mirror root is the sanctioned operation and is not reported", () => {
    expect(replacedMirrorRoots("rm -rf ./dist/*")).toEqual([]);
    expect(replacedMirrorRoots("find ./dist -mindepth 1 -delete")).toEqual([]);
    expect(replacedMirrorRoots("node ../../_tools/scripts/build/clean-outputs.mjs ./generated ./dist ./.cache")).toEqual([]);
});

test("a removal that cannot take a directory at all is not a replacement", () => {
    expect(replacedMirrorRoots("rm -f dist.zip")).toEqual([]);
    expect(replacedMirrorRoots("rm dist")).toEqual([]);
    // Every recursive spelling is one, including the long flag and the capital.
    expect(replacedMirrorRoots("rm -Rf dist")).toEqual(["dist"]);
    expect(replacedMirrorRoots("rm -r -f dist")).toEqual(["dist"]);
    expect(replacedMirrorRoots("rm --recursive --force dist")).toEqual(["dist"]);
    // rmdir and rimraf are always recursive; neither takes a flag to say so.
    expect(replacedMirrorRoots("rmdir generated")).toEqual(["generated"]);
    expect(replacedMirrorRoots("rimraf node_modules")).toEqual(["node_modules"]);
});

test("the last segment decides, so a variable in front of it changes nothing and a path through it does", () => {
    expect(replacedMirrorRoots('rm -rf "$PKG/dist" "$PKG/.cache"')).toEqual(['"$PKG/dist"']);
    expect(replacedMirrorRoots("rm -rf node_modules/")).toEqual(["node_modules/"]);
    expect(replacedMirrorRoots('rm -rf "$out/sandbox" "$out/cli" "$out/extensions"')).toEqual([]);
    expect(replacedMirrorRoots('rm -rf "$out"/sandbox/node_modules/.pnpm/onnxruntime-web@*')).toEqual([]);
});

test("a removal is a command, not any word that happens to be spelled rm", () => {
    // docker rm must read as docker's own verb, not this check's rm.
    expect(replacedMirrorRoots('docker rm -f "$HOST_CONTAINER" >/dev/null 2>&1 || true')).toEqual([]);
    expect(replacedMirrorRoots('docker run -d --rm --name dist "$HOST_IMAGE"')).toEqual([]);
    // pnpm rm is an uninstall with no recursive flag, so it's excluded like any non-recursive rm.
    expect(replacedMirrorRoots("pnpm rm dist")).toEqual([]);
    // A runner in front of a real removal (pnpm exec, sudo) doesn't hide it.
    expect(replacedMirrorRoots("pnpm exec rimraf dist")).toEqual(["dist"]);
    expect(replacedMirrorRoots("sudo rm -rf /srv/app/node_modules")).toEqual(["/srv/app/node_modules"]);
});

test("a find that removes what it names is read through its own predicates", () => {
    const clear = "find . \\( -name 'node_modules' -o -name '.cache' -o -name 'dist' -o -name '.turbo' \\) -prune -exec rm -rf '{}' +";
    expect(replacedMirrorRoots(clear)).toEqual(["'node_modules'", "'dist'"]);
    // A name the find prunes past, not removes, is still reported: telling them apart would need find's expression
    // grammar for no change in answer.
    expect(replacedMirrorRoots("find . -name node_modules -prune -o -name dist -prune -exec rm -rf '{}' +")).toEqual(["node_modules", "dist"]);
    expect(replacedMirrorRoots("find . -name dist -delete")).toEqual(["dist"]);
    // `-mindepth 1` makes a find an emptying: it never yields the directory it started from.
    expect(replacedMirrorRoots("find . -name dist -mindepth 1 -delete")).toEqual([]);
});

test("each command in a line is judged on its own, so a build that ends in a removal is still reported", () => {
    expect(replacedMirrorRoots("pnpm turbo run build && rm -rf dist")).toEqual(["dist"]);
    expect(replacedMirrorRoots("mkdir -p dist; rm -rf dist")).toEqual(["dist"]);
    // Reported once no matter how many commands name it.
    expect(replacedMirrorRoots("rm -rf dist && rm -rf dist")).toEqual(["dist"]);
});
