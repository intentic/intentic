import { describe, expect, test } from "vitest";
import { probeSpec } from "./probes.js";

/* The parsers are the part of this library that faces someone else's output, so they are tested the way that
 * output actually arrives: real shapes, then the shapes that have historically broken things — a tool that
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
        const facts = parse(`outdated`, JSON.stringify({ ok: { current: `1.0.0`, latest: `2.0.0` }, broken: { current: `1.0.0` }, alsoBroken: null }));
        expect(facts).toEqual({ id: `outdated`, packages: [{ name: `ok`, current: `1.0.0`, latest: `2.0.0`, kind: `major`, section: `dependencies` }] });
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
    test(`sums the per-file issue arrays and samples the unreferenced files`, () => {
        const facts = parse(
            `knip`,
            JSON.stringify({
                files: [`src/old.ts`, `src/older.ts`],
                issues: [
                    { file: `src/a.ts`, exports: [{ name: `x` }, { name: `y` }], types: [{ name: `T` }], dependencies: [{ name: `lodash` }], devDependencies: [] },
                    { file: `src/b.ts`, exports: [{ name: `z` }], types: [], dependencies: [], devDependencies: [{ name: `jest` }] },
                ],
            }),
        );
        expect(facts).toEqual({
            id: `knip`,
            deadCode: { files: 2, exports: 3, types: 1, dependencies: 1, devDependencies: 1, sample: [`src/old.ts`, `src/older.ts`] },
        });
    });

    test(`missing per-kind arrays count as zero rather than throwing`, () => {
        expect(parse(`knip`, JSON.stringify({ files: [], issues: [{ file: `src/a.ts` }] }))).toMatchObject({
            deadCode: { files: 0, exports: 0, types: 0, dependencies: 0, devDependencies: 0 },
        });
    });

    // Without a `files` array this is not knip's report, whatever else it contains — and reporting zero dead code
    // from a shape we do not recognise is exactly the lie the state machine exists to prevent.
    test(`a shape without a files array is a failure`, () => {
        expect(parse(`knip`, JSON.stringify({ issues: [] }))).toBeUndefined();
    });
});

describe(`jscpd`, () => {
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
