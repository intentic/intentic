import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { choreById } from "./chores.js";
import { AUDIT_COMMAND, probeSpec } from "./probes.js";
import { IDIOM_RULES } from "./stack.js";
import { WORKSPACE_ROOT_JSCPD_EXCLUDE_ARG, WORKSPACE_ROOT_RG_EXCLUDE_ARG } from "./workspace-scope.js";

// Parsers face real tool output: warning lines before JSON, moved fields, empty runs. Unrecognized output must return
// undefined, never throw, never read as clean.

const parse = (id: Parameters<typeof probeSpec>[0], stdout: string) => probeSpec(id).parse(stdout);

describe(`outdated`, () => {
    test(`reads pnpm's name → {current, latest} map and classifies the semver step`, () => {
        const facts = parse(
            `outdated`,
            JSON.stringify({
                vue: { current: `3.4.1`, latest: `4.0.0`, dependencyType: `dependencies` },
                vitest: { current: `2.1.0`, latest: `2.3.4`, dependencyType: `devDependencies` },
                zod: { current: `4.4.3`, latest: `4.4.9`, dependencyType: `dependencies` },
            }),
        );
        expect(facts).toEqual({
            id: `outdated`,
            packages: [
                { name: `vue`, current: `3.4.1`, latest: `4.0.0`, kind: `major`, section: `dependencies` },
                { name: `vitest`, current: `2.1.0`, latest: `2.3.4`, kind: `minor`, section: `devDependencies` },
                { name: `zod`, current: `4.4.3`, latest: `4.4.9`, kind: `patch`, section: `dependencies` },
            ],
        });
    });

    test(`skips entries pnpm could not resolve, rather than inventing a version for them`, () => {
        const facts = parse(
            `outdated`,
            JSON.stringify({ ok: { current: `1.0.0`, latest: `2.0.0` }, broken: { current: `1.0.0` }, alsoBroken: null }),
        );
        expect(facts).toEqual({
            id: `outdated`,
            packages: [{ name: `ok`, current: `1.0.0`, latest: `2.0.0`, kind: `major`, section: `dependencies` }],
        });
    });

    test(`finds the JSON after a leading warning line`, () => {
        expect(parse(`outdated`, ` WARN  Ignoring broken lockfile\n{"vue":{"current":"1.0.0","latest":"2.0.0"}}`)).toEqual({
            id: `outdated`,
            packages: [{ name: `vue`, current: `1.0.0`, latest: `2.0.0`, kind: `major`, section: `dependencies` }],
        });
    });

    test(`an empty report is no packages, not a failure`, () => {
        expect(parse(`outdated`, `{}`)).toEqual({ id: `outdated`, packages: [] });
    });

    test(`output that is not JSON at all is a failure, never a clean result`, () => {
        expect(parse(`outdated`, `ERR_PNPM_NO_LOCKFILE  Cannot proceed`)).toBeUndefined();
    });

    // pnpm 12's recursive report, verbatim in shape: a package seen as both a dependency and a devDependency is keyed
    // `name@version` and `name@version (dev)`, which once surfaced as two rows under names no registry knows.
    test(`reads pnpm 12's disambiguated keys as the package they name, one row per upgrade`, () => {
        const facts = parse(
            `outdated`,
            JSON.stringify({
                "mermaid@12.0.0 (dev)": { current: `12.0.0`, latest: `12.1.0`, dependencyType: `devDependencies` },
                "mermaid@12.0.0": { current: `12.0.0`, latest: `12.1.0`, dependencyType: `dependencies` },
                "@scope/tool@1.0.0 (dev)": { current: `1.0.0`, latest: `2.0.0`, dependencyType: `devDependencies` },
                "@scope/tool@1.1.0": { current: `1.1.0`, latest: `2.0.0`, dependencyType: `dependencies` },
            }),
        );
        expect(facts).toEqual({
            id: `outdated`,
            packages: [
                // The shipped copy wins the section, whichever order pnpm listed them in.
                { name: `mermaid`, current: `12.0.0`, latest: `12.1.0`, kind: `minor`, section: `dependencies` },
                // Two versions in the tree are two upgrades, so they stay two rows.
                { name: `@scope/tool`, current: `1.0.0`, latest: `2.0.0`, kind: `major`, section: `devDependencies` },
                { name: `@scope/tool`, current: `1.1.0`, latest: `2.0.0`, kind: `major`, section: `dependencies` },
            ],
        });
    });

    test(`a package the workspace leaves out is measured too, and says which folder it is`, () => {
        const stdout = [
            JSON.stringify({ vue: { current: `3.4.1`, latest: `3.4.2`, dependencyType: `dependencies` } }, null, 2),
            `{"standalone":"_editor/ios-app"}`,
            JSON.stringify({ "@capacitor/ios": { current: `8.5.0`, latest: `8.5.2`, dependencyType: `dependencies` } }, null, 2),
        ].join(`\n`);
        expect(parse(`outdated`, stdout)).toEqual({
            id: `outdated`,
            packages: [
                { name: `vue`, current: `3.4.1`, latest: `3.4.2`, kind: `patch`, section: `dependencies` },
                { name: `@capacitor/ios`, current: `8.5.0`, latest: `8.5.2`, kind: `patch`, section: `dependencies`, standalone: `_editor/ios-app` },
            ],
        });
    });

    test(`a standalone package that printed nothing fails the probe rather than reading as up to date`, () => {
        expect(parse(`outdated`, `{}\n{"standalone":"_editor/ios-app"}\n`)).toBeUndefined();
    });
});

describe(`audit`, () => {
    const advisory = (over: Record<string, unknown>) => ({
        module_name: `left-pad`,
        severity: `high`,
        title: `Prototype pollution`,
        patched_versions: `>=1.3.0`,
        findings: [{ dev: false }],
        ...over,
    });

    test(`carries which package, how bad, and whether a fix exists`, () => {
        expect(parse(`audit`, JSON.stringify({ advisories: { "1": advisory({}) } }))).toEqual({
            id: `audit`,
            advisories: [{ name: `left-pad`, severity: `high`, title: `Prototype pollution`, patched: `>=1.3.0`, dev: false }],
        });
    });

    test(`treats "<0.0.0" as no patch published`, () => {
        const facts = parse(`audit`, JSON.stringify({ advisories: { "1": advisory({ patched_versions: `<0.0.0` }) } }));
        expect(facts).toEqual({ id: `audit`, advisories: [expect.not.objectContaining({ patched: expect.anything() })] });
    });

    test(`an advisory is dev-only only when every finding is`, () => {
        const mixed = parse(`audit`, JSON.stringify({ advisories: { "1": advisory({ findings: [{ dev: true }, { dev: false }] }) } }));
        const devOnly = parse(`audit`, JSON.stringify({ advisories: { "1": advisory({ findings: [{ dev: true }, { dev: true }] }) } }));
        expect(mixed).toMatchObject({ advisories: [{ dev: false }] });
        expect(devOnly).toMatchObject({ advisories: [{ dev: true }] });
    });

    test(`a report with no advisories key is clean, not unparseable`, () => {
        expect(parse(`audit`, JSON.stringify({ metadata: { vulnerabilities: { high: 0 } } }))).toEqual({ id: `audit`, advisories: [] });
    });
});

// The audit command run for real, against a fake `pnpm` on PATH: what is under test is the shell (which folders count
// as standalone, the scratch copy, the markers), not pnpm, and not the network.
describe(`the audit command across packages the workspace leaves out`, () => {
    const roots: string[] = [];
    afterEach(() => {
        for (const root of roots.splice(0)) {
            rmSync(root, { recursive: true, force: true });
        }
    });

    // Reports one advisory named after the package it was run in, so the test can see where each run happened.
    // `FAIL_INSTALL` stands in for a registry that cannot be reached.
    const FAKE_PNPM = `#!/bin/sh
name=$(sed -n 's/.*"name": *"\\([^"]*\\)".*/\\1/p' package.json)
case "$*" in
  *"install --lockfile-only"*) [ -z "$FAIL_INSTALL" ] || exit 1; echo "lockfileVersion: '9.0'" > pnpm-lock.yaml ;;
  *audit*) printf '{"advisories":{"1":{"module_name":"%s","severity":"critical","title":"ran in %s","findings":[{"dev":false}]}}}\\n' "$name" "$PWD"; exit 1 ;;
esac
`;

    const repo = (files: Record<string, string>): string => {
        const root = mkdtempSync(join(tmpdir(), `probe-standalone-`));
        roots.push(root);
        for (const [path, text] of Object.entries({ ...files, "bin/pnpm": FAKE_PNPM })) {
            mkdirSync(dirname(join(root, path)), { recursive: true });
            writeFileSync(join(root, path), text);
        }
        chmodSync(join(root, `bin/pnpm`), 0o755);
        return root;
    };

    const audit = (root: string, env: Record<string, string> = {}) =>
        probeSpec(`audit`).parse(
            execFileSync(`sh`, [`-c`, AUDIT_COMMAND], {
                cwd: root,
                encoding: `utf8`,
                env: { ...process.env, ...env, PATH: `${join(root, `bin`)}:${process.env[`PATH`] ?? ``}` },
            }),
        );

    const WORKSPACE = [
        `packages:`,
        `  - "app"`,
        `  # The shell is installed on its own.`,
        `  - "!shell"`,
        `  - '!native/**'`,
        `  - "!**/fixtures/**"`,
        `  - "!gone"`,
        `publicHoistPattern:`,
        `  - "!app"`,
        ``,
    ].join(`\n`);

    test(`audits each literal exclusion with a manifest, in a scratch copy, and names the folder`, () => {
        const root = repo({
            "pnpm-workspace.yaml": WORKSPACE,
            "package.json": `{"name": "root"}`,
            "app/package.json": `{"name": "app"}`,
            "shell/package.json": `{"name": "shell"}`,
            "native/package.json": `{"name": "native"}`,
            "fixtures/x/package.json": `{"name": "fixture"}`,
        });
        const facts = audit(root);
        const advisories = facts?.id === `audit` ? facts.advisories : [];
        // The workspace's own report carries no folder; a fixture, a hoist pattern and a folder that is gone are not packages.
        expect(advisories.map((advisory) => [advisory.name, advisory.standalone])).toEqual([
            [`root`, undefined],
            [`shell`, `shell`],
            [`native`, `native`],
        ]);
        // Measured in a copy: nothing was written into the folder pnpm deliberately does not manage.
        expect(existsSync(join(root, `shell/pnpm-lock.yaml`))).toBe(false);
        expect(JSON.stringify(facts)).not.toContain(`ran in ${join(root, `shell`)}`);
    });

    test(`a standalone package that cannot be resolved fails the probe, never reads as clean`, () => {
        const root = repo({ "pnpm-workspace.yaml": WORKSPACE, "package.json": `{"name": "root"}`, "shell/package.json": `{"name": "shell"}` });
        expect(audit(root, { FAIL_INSTALL: `1` })).toBeUndefined();
    });

    test(`a repo with no workspace file is audited as it always was`, () => {
        const root = repo({ "package.json": `{"name": "root"}` });
        expect(audit(root)).toMatchObject({ advisories: [{ name: `root` }] });
    });
});

describe(`knip`, () => {
    test(`sums the per-file issue arrays and samples the wholly unreferenced files`, () => {
        const facts = parse(
            `knip`,
            JSON.stringify({
                issues: [
                    {
                        file: `src/a.ts`,
                        exports: [{ name: `x` }, { name: `y` }],
                        types: [{ name: `T` }],
                        dependencies: [{ name: `lodash` }],
                        devDependencies: [],
                        files: [],
                    },
                    { file: `src/b.ts`, exports: [{ name: `z` }], types: [], dependencies: [], devDependencies: [{ name: `jest` }], files: [] },
                    { file: `src/old.ts`, exports: [], files: [{ name: `src/old.ts` }] },
                    { file: `src/older.ts`, exports: [], files: [{ name: `src/older.ts` }] },
                ],
            }),
        );
        expect(facts).toEqual({
            id: `knip`,
            deadCode: { files: 2, exports: 3, types: 1, dependencies: 1, devDependencies: 1, sample: [`src/old.ts`, `src/older.ts`] },
        });
    });

    test(`missing per-kind arrays count as zero rather than throwing`, () => {
        expect(parse(`knip`, JSON.stringify({ issues: [{ file: `src/a.ts` }, null] }))).toMatchObject({
            deadCode: { files: 0, exports: 0, types: 0, dependencies: 0, devDependencies: 0, sample: [] },
        });
    });

    test(`an empty issue list is a clean repository, not an unrecognisable one`, () => {
        expect(parse(`knip`, JSON.stringify({ issues: [] }))).toEqual({
            id: `knip`,
            deadCode: { files: 0, exports: 0, types: 0, dependencies: 0, devDependencies: 0, sample: [] },
        });
    });

    test(`a shape without an issues array is a failure`, () => {
        expect(parse(`knip`, JSON.stringify({ files: [`src/old.ts`] }))).toBeUndefined();
    });
});

describe(`jscpd`, () => {
    test(`the root-scoped command carries the reference-shelf prune argument`, () => {
        expect(probeSpec(`jscpd`).command).toContain(WORKSPACE_ROOT_JSCPD_EXCLUDE_ARG);
        expect(choreById(`duplication`)?.automation?.guard).toContain(WORKSPACE_ROOT_JSCPD_EXCLUDE_ARG);
    });

    test(`takes the percentage of scanned lines and the biggest clones, longest first`, () => {
        const facts = parse(
            `jscpd`,
            JSON.stringify({
                statistics: { total: { percentage: 7.4, lines: 1000 } },
                duplicates: [
                    { lines: 12, firstFile: { name: `a.ts` }, secondFile: { name: `b.ts` } },
                    { lines: 40, firstFile: { name: `c.ts` }, secondFile: { name: `d.ts` } },
                ],
            }),
        );
        expect(facts).toEqual({
            id: `jscpd`,
            duplication: {
                percentage: 7.4,
                clones: 2,
                top: [
                    { lines: 40, first: `c.ts`, second: `d.ts` },
                    { lines: 12, first: `a.ts`, second: `b.ts` },
                ],
            },
        });
    });

    test(`a clean run reports zero percent with no clones`, () => {
        expect(parse(`jscpd`, JSON.stringify({ statistics: { total: { percentage: 0 } }, duplicates: [] }))).toMatchObject({
            duplication: { percentage: 0, clones: 0, top: [] },
        });
    });

    test(`no output at all is a failure`, () => {
        expect(parse(`jscpd`, ``)).toBeUndefined();
    });
});

// Two of the eight mutation statuses count counter-intuitively; tested by name since getting either backwards looks
// plausible.
describe(`mutation`, () => {
    const report = (...mutants: readonly Record<string, unknown>[]) =>
        JSON.stringify({
            schemaVersion: `2.0`,
            files: { "src/digest.ts": { language: `typescript`, source: `…`, mutants } },
        });
    const mutant = (status: string, line = 1) => ({
        id: `${status}-${line}`,
        mutatorName: `ConditionalExpression`,
        replacement: `false`,
        location: { start: { line, column: 1 }, end: { line, column: 9 } },
        status,
    });

    test(`counts Killed and Timeout as caught, Survived and NoCoverage as missed`, () => {
        const facts = parse(`mutation`, report(mutant(`Killed`), mutant(`Timeout`), mutant(`Survived`), mutant(`NoCoverage`)));
        expect(facts).toMatchObject({ id: `mutation`, mutation: { killed: 2, survived: 2, score: 50 } });
    });

    test(`leaves mutants that never got a verdict out of the score entirely`, () => {
        const facts = parse(
            `mutation`,
            report(mutant(`Killed`), mutant(`Survived`), mutant(`CompileError`), mutant(`RuntimeError`), mutant(`Ignored`)),
        );
        expect(facts).toMatchObject({ id: `mutation`, mutation: { killed: 1, survived: 1, inconclusive: 3, score: 50 } });
    });

    test(`names each survivor with the change that went unnoticed`, () => {
        const facts = parse(`mutation`, report(mutant(`Survived`, 43)));
        expect(facts).toMatchObject({
            mutation: { survivors: [{ file: `src/digest.ts`, line: 43, mutator: `ConditionalExpression`, replacement: `false` }] },
        });
    });

    test(`renders a deleted expression as a removal rather than as nothing`, () => {
        const facts = parse(`mutation`, report({ ...mutant(`Survived`), replacement: `` }));
        expect(facts).toMatchObject({ mutation: { survivors: [{ replacement: `(removed)` }] } });
    });

    test(`a run with nothing to mutate is 100%, not a division by zero`, () => {
        expect(parse(`mutation`, JSON.stringify({ schemaVersion: `2.0`, files: {} }))).toMatchObject({
            mutation: { score: 100, killed: 0, survived: 0 },
        });
    });

    test(`output without a files map is a failure, not a clean repository`, () => {
        expect(parse(`mutation`, JSON.stringify({ schemaVersion: `2.0` }))).toBeUndefined();
        expect(parse(`mutation`, ``)).toBeUndefined();
        expect(parse(`mutation`, JSON.stringify({ files: [] }))).toBeUndefined();
    });

    test(`survives a malformed mutant without losing the rest of the file's numbers`, () => {
        const facts = parse(`mutation`, report(mutant(`Killed`), { nonsense: true }, mutant(`Survived`)));
        expect(facts).toMatchObject({ mutation: { killed: 1, survived: 1, inconclusive: 1 } });
    });
});

// The sweep is our own command, not third-party JSON; the risk is a silently empty pipeline stage, which the marker
// line exists to catch.
describe(`ui`, () => {
    const sweep = (...lines: readonly string[]) => [`UI`, ...lines].join(`\n`);

    test(`sorts the labelled lines into an inventory, per-file counts and idioms`, () => {
        const facts = parse(
            `ui`,
            sweep(
                `COMPONENT\tsrc/Button.vue`,
                `COMPONENT\tsrc/Card.tsx`,
                `BYPASS\tsrc/Button.vue:3`,
                `IDIOM\tvue-options-api\tsrc/Button.vue`,
                `IDIOM\tvue-2-lifecycle\tsrc/Button.vue`,
                `IDIOM\tvue-options-api\tsrc/Old.vue`,
            ),
        );
        expect(facts).toEqual({
            id: `ui`,
            scan: {
                components: [`src/Button.vue`, `src/Card.tsx`],
                bypasses: [{ path: `src/Button.vue`, count: 3 }],
                idioms: [
                    { id: `vue-options-api`, files: [`src/Button.vue`, `src/Old.vue`] },
                    { id: `vue-2-lifecycle`, files: [`src/Button.vue`] },
                ],
            },
        });
    });

    test(`the marker alone is a clean repository`, () => {
        expect(parse(`ui`, sweep())).toEqual({ id: `ui`, scan: { components: [], bypasses: [], idioms: [] } });
    });

    test(`output with no marker is a failure, however much of it there is`, () => {
        expect(parse(`ui`, ``)).toBeUndefined();
        expect(parse(`ui`, `COMPONENT\tsrc/Button.vue`)).toBeUndefined();
        expect(parse(`ui`, `rg: unrecognized flag --count-matches`)).toBeUndefined();
    });

    test(`splits a count off the end of a path that contains a colon`, () => {
        expect(parse(`ui`, sweep(`BYPASS\tsrc/weird:name.vue:7`))).toMatchObject({ scan: { bypasses: [{ path: `src/weird:name.vue`, count: 7 }] } });
    });

    test(`a line that is not a count is dropped rather than counted as zero`, () => {
        expect(parse(`ui`, sweep(`BYPASS\tsrc/Button.vue`, `BYPASS\tsrc/Card.tsx:notanumber`))).toMatchObject({ scan: { bypasses: [] } });
    });

    test(`strips the prefix ripgrep prints for a path it was told to walk`, () => {
        expect(parse(`ui`, sweep(`COMPONENT\t./src/Button.vue`, `BYPASS\t./src/Button.vue:3`, `IDIOM\tvue-options-api\t./src/Old.vue`))).toEqual({
            id: `ui`,
            scan: {
                components: [`src/Button.vue`],
                bypasses: [{ path: `src/Button.vue`, count: 3 }],
                idioms: [{ id: `vue-options-api`, files: [`src/Old.vue`] }],
            },
        });
    });

    test(`an idiom line naming no file is dropped rather than recorded as an empty path`, () => {
        expect(parse(`ui`, sweep(`IDIOM\tvue-options-api`, `IDIOM\tvue-options-api\t`))).toMatchObject({ scan: { idioms: [] } });
    });
});

// Tests the composed command directly: past bugs here produced no visible difference in output, only a broken command.
describe(`the sweep's composed command`, () => {
    const stages = (): string[] => probeSpec(`ui`).command.split(`; `);

    test(`both ripgrep entry points carry the root-scoped prune argument`, () => {
        expect(probeSpec(`ui`).available).toContain(WORKSPACE_ROOT_RG_EXCLUDE_ARG);
        expect(probeSpec(`ui`).command.split(WORKSPACE_ROOT_RG_EXCLUDE_ARG)).toHaveLength(3 + IDIOM_RULES.length);
    });

    test(`every ripgrep is given a path to walk, including the availability gate`, () => {
        const searches = stages().filter((stage) => stage.startsWith(`rg `));
        expect(searches).toHaveLength(IDIOM_RULES.length + 2);
        for (const search of searches) {
            expect(search.split(`2>/dev/null`)[0], search).toMatch(/ \.\s*$/);
        }
        expect(probeSpec(`ui`).available).toMatch(/ \. >\/dev\/null$/);
    });

    test(`an absent rule asks which files do NOT match, and no rule reaches for PCRE2`, () => {
        for (const rule of IDIOM_RULES) {
            const stage = stages().find((part) => part.includes(`"IDIOM\\t${rule.id}\\t"`));
            expect(stage, rule.id).toContain(rule.absent === undefined ? `rg --no-messages -l ` : `rg --no-messages --files-without-match `);
        }
        expect(probeSpec(`ui`).command).not.toContain(`-P `);
    });
});

describe(`bundle`, () => {
    test(`reads the directory and each asset's raw and gzipped size`, () => {
        const facts = parse(
            `bundle`,
            [`DIR\tdist`, `ASSET\t54038\t41096\tdist/assets/vendor-abc.js`, `ASSET\t2704\t2103\tdist/assets/style.css`].join(`\n`),
        );
        expect(facts).toEqual({
            id: `bundle`,
            bundle: {
                dir: `dist`,
                totalBytes: 56742,
                totalGzip: 43199,
                assets: [
                    { path: `dist/assets/vendor-abc.js`, bytes: 54038, gzip: 41096 },
                    { path: `dist/assets/style.css`, bytes: 2704, gzip: 2103 },
                ],
            },
        });
    });

    test(`a directory line with no assets is an empty build, not a failure`, () => {
        expect(parse(`bundle`, `DIR\tbuild`)).toMatchObject({ bundle: { dir: `build`, assets: [], totalBytes: 0, totalGzip: 0 } });
    });

    test(`no directory line is a failure`, () => {
        expect(parse(`bundle`, ``)).toBeUndefined();
        expect(parse(`bundle`, `find: dist: No such file or directory`)).toBeUndefined();
    });

    test(`an asset whose sizes did not come through is skipped, never counted as zero bytes`, () => {
        expect(parse(`bundle`, [`DIR\tdist`, `ASSET\t\t\tdist/broken.js`, `ASSET\t10\t5\tdist/ok.js`].join(`\n`))).toMatchObject({
            bundle: { assets: [{ path: `dist/ok.js`, bytes: 10, gzip: 5 }] },
        });
    });
});
