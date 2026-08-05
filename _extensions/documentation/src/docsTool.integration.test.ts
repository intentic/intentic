import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* `intentic-docs` against a real git repository, because the two things worth proving about it cannot be proved
 * any other way.
 *
 * ONE: a package's one-liner and its anchors are READ BACK OUT OF ITS README. There is no sidecar to hold them,
 * so if this parsing is wrong every package in the workspace silently loses its description and its links.
 *
 * TWO: staleness is the gap between the last commit that touched the package and the last that touched its
 * README. That is the whole anti-rot mechanism, it is expressed as a git range, and a unit test with a mocked
 * git would only prove the mock agrees with itself. The commits below are the point of the test. */

const BIN = join(import.meta.dirname, `..`, `bin`, `intentic-docs`);

let root: string;
const git = (...args: string[]): void => void execFileSync(`git`, args, { cwd: root, stdio: `ignore` });
const check = (): { entries: { dir: string; oneLiner: string; anchors: { path: string; what: string; line?: number }[]; behind: number; stale: boolean; reason?: string }[]; undocumented: string[] } =>
    JSON.parse(execFileSync(`node`, [BIN, `check`, `--root`, root, `--from`, `published`], { encoding: `utf8` }));
const validate = (): { status: number; output: string } => {
    try {
        return { status: 0, output: execFileSync(`node`, [BIN, `validate`, `--root`, root, `--from`, `published`], { encoding: `utf8` }) };
    } catch (error) {
        const failure = error as { status: number; stderr: string };
        return { status: failure.status, output: failure.stderr };
    }
};

const write = (path: string, content: string): void => {
    mkdirSync(join(root, path, `..`), { recursive: true });
    writeFileSync(join(root, path), content);
};

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), `intentic-docs-`));
    git(`init`, `-q`);
    git(`config`, `user.email`, `t@t.t`);
    git(`config`, `user.name`, `t`);

    mkdirSync(join(root, `_libs/graph/src`), { recursive: true });
    write(`package.json`, `{ "name": "root" }\n`);
    write(`docs/architecture/repo.json`, `{ "repo": "", "provenance": { "sourceRev": "x", "generatedAt": 1 } }\n`);
    write(`docs/architecture/repo.md`, `# root\n`);
    write(`_libs/graph/package.json`, `{ "name": "@t/graph" }\n`);
    write(`_libs/graph/src/compile.ts`, `export const compile = () => 1;\n`);
    write(`_libs/graph/src/types.ts`, `export type G = 1;\n`);
    write(
        `_libs/graph/README.md`,
        [
            `# @t/graph`,
            ``,
            `The shape of "what should exist" — the engine's core data structure. A second sentence that must not`,
            `end up in the one-liner.`,
            ``,
            `## Key files`,
            ``,
            `- [src/compile.ts](src/compile.ts#L42) — RawNode map → validated graph.`,
            `- [src/types.ts](src/types.ts) — the IR types.`,
            `- [the repo](https://example.com) — an external link, which is not an anchor.`,
            ``,
            `## Conventions`,
            ``,
            `- [not-a-key-file.ts](not-a-key-file.ts) — past the section, so not an anchor.`,
            ``,
        ].join(`\n`),
    );
    git(`add`, `-A`);
    git(`commit`, `-qm`, `initial`);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe(`intentic-docs against a real repository`, () => {
    it(`takes the one-liner from the lead sentence, not the lead paragraph`, () => {
        const entry = check().entries.find((candidate) => candidate.dir === `_libs/graph`);
        expect(entry?.oneLiner).toBe(`The shape of "what should exist" — the engine's core data structure.`);
    });

    it(`reads anchors from the key-files section only, resolving them against the repository root`, () => {
        const entry = check().entries.find((candidate) => candidate.dir === `_libs/graph`);
        // Package-relative in the file (so the link works on GitHub) and repo-relative out of the tool.
        expect(entry?.anchors).toEqual([
            { path: `_libs/graph/src/compile.ts`, what: `RawNode map → validated graph.`, line: 42 },
            { path: `_libs/graph/src/types.ts`, what: `the IR types.` },
        ]);
    });

    it(`starts a freshly written page at zero commits behind`, () => {
        const entry = check().entries.find((candidate) => candidate.dir === `_libs/graph`);
        expect(entry).toMatchObject({ behind: 0, stale: false });
    });

    it(`counts a commit that changes the package without its README`, () => {
        write(`_libs/graph/src/compile.ts`, `export const compile = () => 2;\n`);
        git(`add`, `-A`);
        git(`commit`, `-qm`, `change the code only`);
        const entry = check().entries.find((candidate) => candidate.dir === `_libs/graph`);
        expect(entry).toMatchObject({ behind: 1, stale: true });
        expect(entry?.reason).toBe(`1 commit has touched this package since its README was written`);
    });

    /* THE RULE THE WHOLE LAYOUT EXISTS FOR: updating the README in the same commit as the code clears the debt,
     * with nothing to bump and nothing to remember. */
    it(`returns to zero when the README moves in the same commit as the code`, () => {
        write(`_libs/graph/src/compile.ts`, `export const compile = () => 3;\n`);
        write(`_libs/graph/README.md`, `# @t/graph\n\nStill the core data structure.\n\n## Key files\n\n- [src/types.ts](src/types.ts) — the IR types.\n`);
        git(`add`, `-A`);
        git(`commit`, `-qm`, `change the code and its page together`);
        expect(check().entries.find((candidate) => candidate.dir === `_libs/graph`)).toMatchObject({ behind: 0, stale: false });
    });

    it(`fails validation on an anchor that does not resolve, and names it`, () => {
        write(`_libs/graph/README.md`, `# @t/graph\n\nOne sentence.\n\n## Key files\n\n- [src/gone.ts](src/gone.ts) — deleted.\n`);
        const result = validate();
        expect(result.status).toBe(1);
        expect(result.output).toContain(`_libs/graph/src/gone.ts, which does not exist`);
    });

    it(`fails validation on a package with no README, and on a page that never describes itself`, () => {
        mkdirSync(join(root, `_libs/quiet`), { recursive: true });
        write(`_libs/quiet/package.json`, `{ "name": "@t/quiet" }\n`);
        expect(validate().output).toContain(`_libs/quiet has no README.md`);

        write(`_libs/graph/README.md`, `# @t/graph\n\n## Key files\n\n- [src/types.ts](src/types.ts) — the IR types.\n`);
        expect(validate().output).toContain(`has no lead sentence`);
    });

    it(`reports a package with no page as undocumented rather than dropping it`, () => {
        expect(check().undocumented).toContain(`_libs/quiet`);
    });
});
