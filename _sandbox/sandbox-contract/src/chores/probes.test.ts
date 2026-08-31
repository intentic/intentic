import { describe, expect, test } from "vitest";
import { choreById } from "./chores.js";
import { probeSpec } from "./probes.js";
import { IDIOM_RULES } from "./stack.js";
import { WORKSPACE_ROOT_JSCPD_EXCLUDE_ARG, WORKSPACE_ROOT_RG_EXCLUDE_ARG } from "./workspace-scope.js";

/* The parsers are the part of this library that faces someone else's output, so they are tested the way that
 * output actually arrives: real shapes, then the shapes that have historically broken things, a tool that
 * printed a warning line before its JSON, a version whose fields moved, an empty run. The bar for every one of
 * them is the same: recognise it, or return undefined so the runner can record a failure. Never throw, and never
 * report a clean result from output it did not understand. */

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

    // pnpm prints deprecation and lockfile notices on the same stream in some versions; the JSON still has to be
    // found. This is the single most common reason a parser like this silently reports "clean".
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

    // "<0.0.0" is npm's spelling of "no version fixes this". Treating it as a range would have the chore promise
    // a bump that cannot be made, which is the one thing a security prompt must not do.
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

    // A clean run still prints the envelope, and an empty one is the answer that keeps the chore quiet.
    test(`an empty issue list is a clean repository, not an unrecognisable one`, () => {
        expect(parse(`knip`, JSON.stringify({ issues: [] }))).toEqual({
            id: `knip`,
            deadCode: { files: 0, exports: 0, types: 0, dependencies: 0, devDependencies: 0, sample: [] },
        });
    });

    // Without an `issues` array this is not knip's report, whatever else it contains, and reporting zero dead code
    // from a shape we do not recognise is exactly the lie the state machine exists to prevent.
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

    // jscpd writes its report to a file; when the run dies the `cat` in the command prints nothing at all.
    test(`no output at all is a failure`, () => {
        expect(parse(`jscpd`, ``)).toBeUndefined();
    });
});

/* The mutation report is the cross-tool "mutation testing report schema", and the whole risk in this parser is
 * the arithmetic rather than the shape: two of the eight statuses land on the counter-intuitive side, and getting
 * either one backwards produces a number that looks plausible and is wrong. So the statuses are tested by name. */
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
        // Stryker's own arithmetic, restated as a test because both halves read backwards at a glance: a mutant
        // that HANGS the suite was noticed by it, and a mutant nothing ran cannot have been.
        const facts = parse(`mutation`, report(mutant(`Killed`), mutant(`Timeout`), mutant(`Survived`), mutant(`NoCoverage`)));
        expect(facts).toMatchObject({ id: `mutation`, mutation: { killed: 2, survived: 2, score: 50 } });
    });

    test(`leaves mutants that never got a verdict out of the score entirely`, () => {
        // One caught, one missed, and three with no answer: the score is 50%, not 20% and not 80%. Folding the
        // undecided into either column is the mistake this pins.
        const facts = parse(`mutation`, report(mutant(`Killed`), mutant(`Survived`), mutant(`CompileError`), mutant(`RuntimeError`), mutant(`Ignored`)));
        expect(facts).toMatchObject({ id: `mutation`, mutation: { killed: 1, survived: 1, inconclusive: 3, score: 50 } });
    });

    test(`names each survivor with the change that went unnoticed`, () => {
        const facts = parse(`mutation`, report(mutant(`Survived`, 43)));
        expect(facts).toMatchObject({
            mutation: { survivors: [{ file: `src/digest.ts`, line: 43, mutator: `ConditionalExpression`, replacement: `false` }] },
        });
    });

    // A mutator that DELETES an expression reports an empty replacement, which would otherwise render as a blank
    // in the panel and read as a missing field rather than as the removal it is.
    test(`renders a deleted expression as a removal rather than as nothing`, () => {
        const facts = parse(`mutation`, report({ ...mutant(`Survived`), replacement: `` }));
        expect(facts).toMatchObject({ mutation: { survivors: [{ replacement: `(removed)` }] } });
    });

    test(`a run with nothing to mutate is 100%, not a division by zero`, () => {
        expect(parse(`mutation`, JSON.stringify({ schemaVersion: `2.0`, files: {} }))).toMatchObject({
            mutation: { score: 100, killed: 0, survived: 0 },
        });
    });

    // The distinction the runner depends on: an empty `files` map is a real measurement, a MISSING one is output
    // this parser did not understand, and reporting the second as a clean 100% is the one answer it must never give.
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

/* The UI sweep is the one probe whose output we produce ourselves, which removes the "their JSON moved" failure
 * and replaces it with a worse one: a command of eleven piped ripgreps in which any single stage can silently
 * contribute nothing. The marker line is what tells those two apart, and most of what is below is about it. */
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

    /* The distinction the marker exists for, and the one this whole probe would get wrong without it: a
     * repository with no components and no findings emits exactly the marker, while a sweep that never ran emits
     * nothing. Collapsing them would report a spotless front-end for a command that failed to start. */
    test(`the marker alone is a clean repository`, () => {
        expect(parse(`ui`, sweep())).toEqual({ id: `ui`, scan: { components: [], bypasses: [], idioms: [] } });
    });

    test(`output with no marker is a failure, however much of it there is`, () => {
        expect(parse(`ui`, ``)).toBeUndefined();
        expect(parse(`ui`, `COMPONENT\tsrc/Button.vue`)).toBeUndefined();
        expect(parse(`ui`, `rg: unrecognized flag --count-matches`)).toBeUndefined();
    });

    // A path with a colon in it is legal and rare; the count is always the digits after the last one.
    test(`splits a count off the end of a path that contains a colon`, () => {
        expect(parse(`ui`, sweep(`BYPASS\tsrc/weird:name.vue:7`))).toMatchObject({ scan: { bypasses: [{ path: `src/weird:name.vue`, count: 7 }] } });
    });

    test(`a line that is not a count is dropped rather than counted as zero`, () => {
        expect(parse(`ui`, sweep(`BYPASS\tsrc/Button.vue`, `BYPASS\tsrc/Card.tsx:notanumber`))).toMatchObject({ scan: { bypasses: [] } });
    });

    /* Every path the sweep prints wears a `./`, because every ripgrep in it is handed `.` to walk. Downstream this
     * would have to be remembered at each comparison: jscpd's paths against the component list, a bypass against
     * a component, so it is spent once, here, and one spelling of a path leaves the parser. */
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

/* THE COMMAND ITSELF, which for this probe is generated and therefore the thing to test. Both cases below are
 * bugs that reached a real repository and could not be seen in the output: one made the sweep silently empty, the
 * other made it depend on a ripgrep feature that is a compile-time option. */
describe(`the sweep's composed command`, () => {
    const stages = (): string[] => probeSpec(`ui`).command.split(`; `);

    test(`both ripgrep entry points carry the root-scoped prune argument`, () => {
        expect(probeSpec(`ui`).available).toContain(WORKSPACE_ROOT_RG_EXCLUDE_ARG);
        expect(probeSpec(`ui`).command.split(WORKSPACE_ROOT_RG_EXCLUDE_ARG)).toHaveLength(3 + IDIOM_RULES.length);
    });

    /* Given no path, ripgrep searches STDIN whenever stdin is not a TTY, which is exactly how a probe is spawned.
     * The sweep exited 0, printed its marker and matched nothing, in every repository, forever, which the marker
     * line cannot catch because the sweep really did run. It reproduces from a child process and never from an
     * interactive shell, so the command is the only place it is visible. */
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

    // The `find` prints nothing for a directory that exists but holds no assets. `available` is supposed to catch
    // that, and this is the second line of defence: a zero-byte bundle would otherwise read as a fact.
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
