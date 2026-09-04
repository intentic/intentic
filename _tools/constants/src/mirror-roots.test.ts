import { expect, test } from "vitest";
// @ts-expect-error -- hand-written .mjs with a .d.mts beside it; see mirror-roots.mjs for why it isn't compiled.
import { MIRRORED_DIRS, replacedMirrorRoots } from "./mirror-roots.mjs";

/* WHAT THIS IS MEASURING. `replacedMirrorRoots` decides whether a shell command would give one of the overlay
 * mount roots a new inode, which is the operation that empties that directory for every live agent turn at
 * once. The gate that runs it (_tools/checks/mirror-roots.mjs) reads every package script and every tracked
 * shell script in the repository, so both halves matter equally: a shape it misses is an incident that recurs,
 * and a shape it over-reports is a gate someone switches off. The negatives below are therefore the same size
 * as the positives, and each is a line that really appears in this repository. */

// The command that caused the incident, exactly as `_platform/prisma`'s build script used to spell it.
const PRISMA_BUILD = "rm -rf ./generated ./dist ./.cache && DATABASE_URL=postgresql://placeholder prisma generate --no-hints && tsgo";

test("the mirror roots are the three trees a checkout cannot carry", () => {
    expect([...MIRRORED_DIRS].toSorted()).toEqual(["dist", "generated", "node_modules"]);
});

test("the removal that emptied every agent's prisma output is reported, and the cache beside it is not", () => {
    // `.cache` is not mirrored (isolation.ts says why a mirrored build cache would be worse than none), so
    // removing it outright stays correct and must not be reported alongside the two that are.
    expect(replacedMirrorRoots(PRISMA_BUILD)).toEqual(["./generated", "./dist"]);
});

test("removing the CONTENTS of a mirror root is the sanctioned operation and is not reported", () => {
    // The inode survives all three of these, which is the whole distinction the check is built on.
    expect(replacedMirrorRoots("rm -rf ./dist/*")).toEqual([]);
    expect(replacedMirrorRoots("find ./dist -mindepth 1 -delete")).toEqual([]);
    expect(replacedMirrorRoots("node ../../_tools/scripts/build/clean-outputs.mjs ./generated ./dist ./.cache")).toEqual([]);
});

test("a removal that cannot take a directory at all is not a replacement", () => {
    // `_computers/webext` removes `dist.zip` beside its `dist`, and a bare `rm` refuses a directory outright.
    expect(replacedMirrorRoots("rm -f dist.zip")).toEqual([]);
    expect(replacedMirrorRoots("rm dist")).toEqual([]);
    // Every recursive spelling is one, though, including the long flag and the capital.
    expect(replacedMirrorRoots("rm -Rf dist")).toEqual(["dist"]);
    expect(replacedMirrorRoots("rm -r -f dist")).toEqual(["dist"]);
    expect(replacedMirrorRoots("rm --recursive --force dist")).toEqual(["dist"]);
    // rmdir and rimraf are recursive by nature: neither takes a flag to say so.
    expect(replacedMirrorRoots("rmdir generated")).toEqual(["generated"]);
    expect(replacedMirrorRoots("rimraf node_modules")).toEqual(["node_modules"]);
});

test("the last segment decides, so a variable in front of it changes nothing and a path through it does", () => {
    // tsgo-emit-pilot.sh's shape: the package is a parameter and the mirror root is still a mirror root.
    expect(replacedMirrorRoots('rm -rf "$PKG/dist" "$PKG/.cache"')).toEqual(['"$PKG/dist"']);
    expect(replacedMirrorRoots("rm -rf node_modules/")).toEqual(["node_modules/"]);
    // prepare-image-trees.sh, which works on a staging tree and names things INSIDE an installed tree. Neither
    // is a mount root, and reporting them is how a gate becomes noise.
    expect(replacedMirrorRoots('rm -rf "$out/sandbox" "$out/cli" "$out/extensions"')).toEqual([]);
    expect(replacedMirrorRoots('rm -rf "$out"/sandbox/node_modules/.pnpm/onnxruntime-web@*')).toEqual([]);
});

test("a removal is a command, not any word that happens to be spelled rm", () => {
    // Half the shell scripts here reap containers; `docker rm` must read as docker's verb and nothing else.
    expect(replacedMirrorRoots('docker rm -f "$HOST_CONTAINER" >/dev/null 2>&1 || true')).toEqual([]);
    expect(replacedMirrorRoots('docker run -d --rm --name dist "$HOST_IMAGE"')).toEqual([]);
    // `pnpm rm <package>` is an uninstall and takes no recursive flag, so the same rule keeps it out.
    expect(replacedMirrorRoots("pnpm rm dist")).toEqual([]);
    // A runner in front of a real removal does not hide it, though.
    expect(replacedMirrorRoots("pnpm exec rimraf dist")).toEqual(["dist"]);
    expect(replacedMirrorRoots("sudo rm -rf /srv/app/node_modules")).toEqual(["/srv/app/node_modules"]);
});

test("a find that removes what it names is read through its own predicates", () => {
    // The root `clear` script's shape: the removal's operand is a placeholder, so only the find says what goes.
    const clear = "find . \\( -name 'node_modules' -o -name '.cache' -o -name 'dist' -o -name '.turbo' \\) -prune -exec rm -rf '{}' +";
    expect(replacedMirrorRoots(clear)).toEqual(["'node_modules'", "'dist'"]);
    // A name the find PRUNES past rather than removes is reported too, and deliberately: implementing find's
    // expression grammar to tell them apart would change no answer, since neither name may be removed here.
    expect(replacedMirrorRoots("find . -name node_modules -prune -o -name dist -prune -exec rm -rf '{}' +")).toEqual(["node_modules", "dist"]);
    // `-delete` removes with no `rm` anywhere on the line to notice.
    expect(replacedMirrorRoots("find . -name dist -delete")).toEqual(["dist"]);
    // …and `-mindepth 1` is what makes a find an emptying: it never yields the directory it started from.
    expect(replacedMirrorRoots("find . -name dist -mindepth 1 -delete")).toEqual([]);
});

test("each command in a line is judged on its own, so a build that ends in a removal is still reported", () => {
    expect(replacedMirrorRoots("pnpm turbo run build && rm -rf dist")).toEqual(["dist"]);
    expect(replacedMirrorRoots("mkdir -p dist; rm -rf dist")).toEqual(["dist"]);
    // Reported once however many commands name it.
    expect(replacedMirrorRoots("rm -rf dist && rm -rf dist")).toEqual(["dist"]);
});
