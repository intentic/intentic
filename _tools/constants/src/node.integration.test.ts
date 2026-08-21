import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
// @ts-expect-error -- hand-written .mjs with a .d.mts beside it; see node.mjs for why it isn't compiled.
import { packageRoot, repoRoot } from "./node.mjs";

/* A throwaway checkout shaped like the real one: a root carrying the marker, a package three levels down
 * carrying its own manifest, and a file deeper still. Built on disk rather than mocked because the whole point
 * of these helpers is what they see on a filesystem. */
const fixture = (): { root: string; pkg: string; deep: string } => {
    const root = mkdtempSync(join(tmpdir(), `constants-node-`));
    writeFileSync(join(root, `pnpm-workspace.yaml`), `packages:\n  - "_group/*"\n`);
    writeFileSync(join(root, `package.json`), `{"name":"root"}`);
    const pkg = join(root, `_group`, `thing`);
    mkdirSync(join(pkg, `src`, `lib`, `deeper`), { recursive: true });
    writeFileSync(join(pkg, `package.json`), `{"name":"thing"}`);
    const deep = join(pkg, `src`, `lib`, `deeper`, `mod.js`);
    writeFileSync(deep, `export const x = 1;\n`);
    return { root, pkg, deep };
};

test(`repoRoot: same answer from a file URL, a file path and a directory path`, () => {
    const { root, pkg, deep } = fixture();
    expect(repoRoot(pathToFileURL(deep).href)).toBe(root);
    expect(repoRoot(deep)).toBe(root);
    expect(repoRoot(join(pkg, `src`))).toBe(root);
});

/* THE PROPERTY THE COUNTING VERSION DID NOT HAVE, and the only reason this module exists. `../..` is right for
 * exactly one depth; every one of these callers would have needed a different number of dots, and picking the
 * wrong one failed silently by resolving to a real-but-wrong directory. */
test(`repoRoot: depth does not change the answer`, () => {
    const { root, pkg, deep } = fixture();
    const everyDepth = [root, pkg, join(pkg, `src`), join(pkg, `src`, `lib`), join(pkg, `src`, `lib`, `deeper`), deep];
    expect(everyDepth.map((from) => repoRoot(from))).toEqual(everyDepth.map(() => root));
});

test(`repoRoot: a path that does not exist resolves from the directory it would sit in`, () => {
    const { root, pkg } = fixture();
    expect(repoRoot(join(pkg, `src`, `lib`, `not-written-yet.ts`))).toBe(root);
});

test(`packageRoot: the nearest manifest wins over the root's`, () => {
    const { root, pkg, deep } = fixture();
    expect(packageRoot(deep)).toBe(pkg);
    expect(packageRoot(root)).toBe(root);
});

/* Loud, not lenient. The counting version's failure mode was to return a confident wrong directory, which is
 * how a config loader reads no .env and hands every credential back empty: a failure that surfaces far from
 * its cause. Nothing above the system's temp dir carries the marker, so this is a genuine miss. */
test(`repoRoot: throws rather than guessing when the marker is nowhere above`, () => {
    expect(() => repoRoot(mkdtempSync(join(tmpdir(), `no-marker-`)))).toThrow(/pnpm-workspace\.yaml/);
});
