import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { packageOf, passesAgainstHead } from "./agent-test-strength.js";

// Runs the mechanism against a real git repo and real vitest, nothing stubbed: the seam between config, baseline and
// verdict is what breaks in practice. The fixture is the real example: a relational assertion can't see the change
// here, an exact one can, which is exactly what this hook must tell apart.

// vitest lives in each package's node_modules, not the workspace root; the fixture borrows this package's tree.
const INSTALLED = join(import.meta.dirname, `../../../node_modules`);

const roots: string[] = [];
afterAll(() => {
    for (const root of roots) {
        rmSync(root, { recursive: true, force: true });
    }
});

const HEAD_SOURCE = `export const bucket = (n: number): number => Math.floor(Math.log2(n));\n`;
const CHANGED_SOURCE = `export const bucket = (n: number): number => (n <= 0 ? -1 : Math.floor(Math.log2(n)));\n`;

// A repo whose HEAD has the old `bucket` and working tree has the new one: the shape of a turn that just made a change
// and is about to test it.
const repoWithChange = (): { readonly root: string; readonly testFile: string } => {
    const root = mkdtempSync(join(tmpdir(), `strength-repo-`));
    roots.push(root);
    const pkg = join(root, `pkg`);
    mkdirSync(join(pkg, `src`), { recursive: true });
    symlinkSync(INSTALLED, join(pkg, `node_modules`));
    writeFileSync(join(pkg, `package.json`), JSON.stringify({ name: `fixture`, type: `module`, private: true }));
    // Self-contained: no import of shared vitest options, so the generated config has exactly one thing to merge.
    writeFileSync(join(pkg, `vitest.config.ts`), `export default { test: { include: ["./**/*.test.ts"], environment: "node" } };\n`);
    writeFileSync(join(pkg, `src/bucket.ts`), HEAD_SOURCE);

    const git = (...args: readonly string[]) => execFileSync(`git`, [...args], { cwd: root, stdio: `ignore` });
    git(`init`, `-q`);
    git(`config`, `user.email`, `fixture@example.com`);
    git(`config`, `user.name`, `fixture`);
    git(`add`, `-A`);
    git(`commit`, `-qm`, `head`);

    // The change itself, uncommitted, which is what `git diff HEAD` reports and what gets reverted for the run.
    writeFileSync(join(pkg, `src/bucket.ts`), CHANGED_SOURCE);
    return { root, testFile: join(pkg, `src/bucket.test.ts`) };
};

// The finding is the list of source files restored for the run; the built-in turns that into a sentence, undefined is
// silence.
const ask = (root: string, testFile: string): Promise<readonly string[] | undefined> => passesAgainstHead(testFile, { repoRoot: root });

// Which package a test belongs to, tested here rather than in the unit suite since it reads the disk for a real vitest
// config.
describe(`which package a test belongs to`, () => {
    const tree = (files: Readonly<Record<string, string>>): string => {
        const root = mkdtempSync(join(tmpdir(), `strength-tree-`));
        roots.push(root);
        for (const [path, content] of Object.entries(files)) {
            const at = join(root, path);
            mkdirSync(join(at, `..`), { recursive: true });
            writeFileSync(at, content);
        }
        return root;
    };

    test(`walks up to the nearest vitest config`, () => {
        const root = tree({ "pkg/vitest.config.ts": ``, "pkg/src/deep/x.test.ts": `` });
        expect(packageOf(join(root, `pkg/src/deep/x.test.ts`), root)).toBe(join(root, `pkg`));
    });

    test(`stops at the repo root rather than escaping it`, () => {
        // Without the bound this walk could reach / and pick up another checkout's config; must answer no package.
        const root = tree({ "pkg/src/x.test.ts": `` });
        expect(packageOf(join(root, `pkg/src/x.test.ts`), join(root, `pkg`))).toBeUndefined();
    });

    test(`a package with no vitest config has no suite to borrow settings from`, () => {
        const root = tree({ "pkg/package.json": `{}`, "pkg/src/x.test.ts": `` });
        expect(packageOf(join(root, `pkg/src/x.test.ts`), root)).toBeUndefined();
    });
});

describe(`a test re-run against the code as it was`, () => {
    test(`reports a test that passes without the change`, async () => {
        const { root, testFile } = repoWithChange();
        writeFileSync(
            testFile,
            [
                `import { expect, test } from "vitest";`,
                `import { bucket } from "./bucket.js";`,
                // Relational, and blind: -Infinity and 0 differ just as happily as -1 and 0 do.
                `test("zero is its own bucket", () => { expect(bucket(0)).not.toBe(bucket(1)); });`,
                ``,
            ].join(`\n`),
        );
        // Names the file whose reversion it survived, so the reader can tell which change went untested.
        expect(await ask(root, testFile)).toEqual([`pkg/src/bucket.ts`]);
    });

    test(`says nothing about a test that fails without the change`, async () => {
        const { root, testFile } = repoWithChange();
        writeFileSync(
            testFile,
            [
                `import { expect, test } from "vitest";`,
                `import { bucket } from "./bucket.js";`,
                // Exact, at the boundary: -Infinity is not -1, so this is red without the change.
                `test("zero is its own bucket", () => { expect(bucket(0)).toBe(-1); });`,
                ``,
            ].join(`\n`),
        );
        expect(await ask(root, testFile)).toBeUndefined();
    });

    test(`says nothing when the turn has changed no source to revert`, async () => {
        // A test against untouched code has no mutant; inventing one would flag every test in an unfamiliar package.
        const { root, testFile } = repoWithChange();
        writeFileSync(join(root, `pkg/src/bucket.ts`), HEAD_SOURCE);
        writeFileSync(testFile, [`import { expect, test } from "vitest";`, `test("trivially true", () => { expect(1).toBe(1); });`, ``].join(`\n`));
        expect(await ask(root, testFile)).toBeUndefined();
    });

    test(`leaves nothing behind in the package it measured`, async () => {
        const { root, testFile } = repoWithChange();
        writeFileSync(testFile, [`import { expect, test } from "vitest";`, `test("t", () => { expect(1).toBe(1); });`, ``].join(`\n`));
        await ask(root, testFile);
        // The generated config is the only write here, asserted as the whole listing: a stray cache counts too.
        const listed = execFileSync(`git`, [`status`, `--porcelain`, `--untracked-files=all`], { cwd: root, encoding: `utf8` });
        expect(listed).toBe(` M pkg/src/bucket.ts\n?? pkg/src/bucket.test.ts\n`);
        // And the working copy of the changed source is still the CHANGED one, never the reverted text.
        expect(execFileSync(`cat`, [join(root, `pkg/src/bucket.ts`)], { encoding: `utf8` })).toBe(CHANGED_SOURCE);
    });
});
