import type {
    Bundle,
    ChoreLedgerEntry,
    ChorePackage,
    ChoreShape,
    ChoreSignals,
    ChoresReport,
    Duplication,
    ProbeResult,
    UiScan,
} from "../schemas/maintenance.js";
import { describe, expect, test } from "vitest";
import { choreById, CHORES } from "./chores.js";
import { assessReport, choreAnswer, choreAnswered, ledgerKey, unseenVerdicts } from "./verdict.js";

// The chore verdict state machine, tested at the distinctions a simpler design gets wrong: reporting an unmeasured repo
// clean, badging the same finding repeatedly, a snooze becoming permanent, or a false-positive report being forgotten.

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 31);

const pkg = (over: Partial<ChorePackage> = {}): ChorePackage => ({
    dir: `_libs/thing`,
    name: `@x/thing`,
    dependencies: [],
    devDependencies: [],
    documented: true,
    ...over,
});

// A repo where every chore applies by default, so an applicability test only has to toggle the one fact it's about.
const shape = (over: Partial<ChoreShape> = {}): ChoreShape => ({
    docs: [`docs/architecture/repo.md`],
    dockerfiles: [`Dockerfile`],
    ci: [`.github/workflows/ci.yml`],
    lockfile: true,
    packageManifest: true,
    deps: [`tailwindcss`, `vue`],
    ...over,
});

const signals = (over: Partial<ChoreSignals> = {}): ChoreSignals => ({
    packages: [pkg()],
    shape: shape(),
    hotspots: [],
    keyModules: [],
    totals: { files: 100, symbols: 1000, complexity: 900, hotspots: 0 },
    indexed: true,
    ...over,
});

const probe = (over: Partial<ProbeResult> & Pick<ProbeResult, "id">): ProbeResult => ({ state: `ok`, ranAt: NOW - DAY, tookMs: 1000, ...over });

const auditProbe = (names: readonly string[]): ProbeResult =>
    probe({
        id: `audit`,
        facts: {
            id: `audit`,
            advisories: names.map((name) => ({ name, severity: `high` as const, title: `${name} is bad`, patched: `>=2`, dev: false })),
        },
    });

const report = (over: Partial<ChoresReport> = {}): ChoresReport => ({
    repos: [{ repo: `app`, probes: [], signals: signals() }],
    ledger: [],
    // Verdicts are about evidence, not work in flight; empty here since no test in this file depends on it.
    running: [],
    node: `v24.18.0`,
    ...over,
});

const verdictFor = (input: ChoresReport, chore: string, repo = `app`) => {
    const found = assessReport(input, NOW).find((verdict) => verdict.chore.id === chore && verdict.repo === repo);
    if (found === undefined) {
        throw new Error(`no verdict for ${chore} in ${repo}`);
    }
    return found;
};

describe(`what "we have not measured this" means`, () => {
    test(`a chore whose probe never ran is unavailable, not clear`, () => {
        const verdict = verdictFor(report(), `security-advisories`);
        expect(verdict.state).toBe(`unavailable`);
        expect(verdict.detail.join(` `)).toContain(`Security advisories`);
    });

    test(`a probe the repository cannot run says so, and never badges`, () => {
        const knipReason = `knip is not a devDependency`;
        const input = report({
            repos: [
                { repo: `app`, probes: [probe({ id: `knip`, state: `unavailable`, reason: knipReason })], signals: signals() },
            ],
        });
        const verdict = verdictFor(input, `dead-code`);
        expect(verdict.state).toBe(`unavailable`);
        expect(verdict.detail[0]).toContain(knipReason);
        expect(unseenVerdicts([verdict], {})).toEqual([]);
    });

    test(`a probe that ran and found nothing is clear, with no prompt to spend a turn on`, () => {
        const verdict = verdictFor(report({ repos: [{ repo: `app`, probes: [auditProbe([])], signals: signals() }] }), `security-advisories`);
        expect(verdict.state).toBe(`clear`);
        expect(verdict.prompt).toBeUndefined();
    });
});

describe(`the ledger debounces; it cannot hide`, () => {
    const withAdvisories = report({ repos: [{ repo: `app`, probes: [auditProbe([`left-pad`])], signals: signals() }] });
    const ledgerEntry = (over: Partial<ChoreLedgerEntry> = {}): ChoreLedgerEntry => ({
        repo: `app`,
        chore: `security-advisories`,
        ranAt: NOW - DAY,
        runId: `r1`,
        outcome: `acted`,
        digest: verdictFor(withAdvisories, `security-advisories`).digest,
        ...over,
    });

    test(`a run against this exact evidence leaves the chore due but settled: shown, never badged`, () => {
        const verdict = verdictFor({ ...withAdvisories, ledger: [ledgerEntry()] }, `security-advisories`);
        expect(verdict.state).toBe(`due`);
        expect(verdict.settled).toBe(true);
        expect(unseenVerdicts([verdict], {})).toEqual([]);
    });

    test(`evidence that has moved since the run is unsettled again`, () => {
        const moved = report({
            repos: [{ repo: `app`, probes: [auditProbe([`left-pad`, `minimist`])], signals: signals() }],
            ledger: [ledgerEntry()],
        });
        const verdict = verdictFor(moved, `security-advisories`);
        expect(verdict.state).toBe(`due`);
        expect(verdict.settled).toBe(false);
        expect(unseenVerdicts([verdict], {})).toHaveLength(1);
    });

    test(`an agent reporting the findings did not hold up clears the chore until the evidence changes`, () => {
        const due = verdictFor(withAdvisories, `security-advisories`);
        const verdict = verdictFor({ ...withAdvisories, ledger: [ledgerEntry({ outcome: `clean` })] }, `security-advisories`);
        expect(verdict.state).toBe(`clear`);
        expect(verdict.headline).not.toBe(due.headline);
    });

    test(`a snooze silences a due chore without hiding it, and lapses on its own`, () => {
        const snoozed = verdictFor({ ...withAdvisories, ledger: [ledgerEntry({ snoozedUntil: NOW + DAY })] }, `security-advisories`);
        expect(snoozed.state).toBe(`snoozed`);
        expect(snoozed.detail).not.toEqual([]);
        expect(unseenVerdicts([snoozed], {})).toEqual([]);

        const lapsed = verdictFor({ ...withAdvisories, ledger: [ledgerEntry({ snoozedUntil: NOW - 1 })] }, `security-advisories`);
        expect(lapsed.state).toBe(`due`);
    });

    test(`settlement expires with the chore's cadence, and persists for the chores that have none`, () => {
        const dependencies = choreById(`dependencies-outdated`);
        expect(dependencies?.cadenceMs).toBeGreaterThan(0);
        expect(choreById(`security-advisories`)?.cadenceMs).toBe(0);

        const old = { ...withAdvisories, ledger: [ledgerEntry({ ranAt: NOW - 400 * DAY })] };
        expect(verdictFor(old, `security-advisories`).settled).toBe(true);
    });
});

// Guards the case an unchanged digest alone can't tell apart: a probe that never re-ran looks identical to a fix
// that didn't work, and both used to read as a confident `due`.
describe(`a measurement older than the work is not evidence about the work`, () => {
    const withAdvisories = report({ repos: [{ repo: `app`, probes: [auditProbe([`left-pad`])], signals: signals() }] });
    const ledgerEntry = (over: Partial<ChoreLedgerEntry> = {}): ChoreLedgerEntry => ({
        repo: `app`,
        chore: `security-advisories`,
        ranAt: NOW - DAY,
        runId: `r1`,
        outcome: `acted`,
        digest: verdictFor(withAdvisories, `security-advisories`).digest,
        ...over,
    });

    // Probe ran a day ago, the ledger entry an hour ago: nothing has looked since the entry.
    test(`a turn that landed after the measurement steps the chore down from due`, () => {
        const verdict = verdictFor({ ...withAdvisories, ledger: [ledgerEntry({ ranAt: NOW - 3_600_000 })] }, `security-advisories`);
        expect(verdict.state).toBe(`stale`);
        expect(verdict.detail).not.toEqual([]);
        expect(verdict.settled).toBe(false);
    });

    test(`a stale chore offers no turn and never badges`, () => {
        const verdict = verdictFor({ ...withAdvisories, ledger: [ledgerEntry({ ranAt: NOW - 3_600_000 })] }, `security-advisories`);
        expect(verdict.prompt).toBeUndefined();
        expect(unseenVerdicts([verdict], {})).toEqual([]);
    });

    test(`re-measuring after the turn restores the verdict: due, and now genuinely settled`, () => {
        const remeasured = report({
            repos: [{ repo: `app`, probes: [{ ...auditProbe([`left-pad`]), ranAt: NOW - 60_000 }], signals: signals() }],
            ledger: [ledgerEntry({ ranAt: NOW - 3_600_000 })],
        });
        const verdict = verdictFor(remeasured, `security-advisories`);
        expect(verdict.state).toBe(`due`);
        expect(verdict.settled).toBe(true);
    });

    test(`an agent reporting the findings did not hold up still clears the chore`, () => {
        const verdict = verdictFor({ ...withAdvisories, ledger: [ledgerEntry({ ranAt: NOW - 3_600_000, outcome: `clean` })] }, `security-advisories`);
        expect(verdict.state).toBe(`clear`);
    });

    test(`a snooze still wins`, () => {
        const verdict = verdictFor(
            { ...withAdvisories, ledger: [ledgerEntry({ ranAt: NOW - 3_600_000, snoozedUntil: NOW + DAY })] },
            `security-advisories`,
        );
        expect(verdict.state).toBe(`snoozed`);
    });

    test(`every measured verdict says when it was measured, and the unmeasurable ones say nothing`, () => {
        expect(verdictFor(withAdvisories, `security-advisories`).measuredAt).toBe(NOW - DAY);
        expect(verdictFor(report(), `standardize-patterns`).measuredAt).toBeUndefined();
        expect(verdictFor(report(), `security-advisories`).measuredAt).toBeUndefined();
    });
});

describe(`surveys are due because time passed, and say so`, () => {
    const surveyLedger = (ranAt: number): ChoreLedgerEntry => ({
        repo: `app`,
        chore: `standardize-patterns`,
        ranAt,
        runId: `r1`,
        outcome: `reported`,
        digest: `whatever`,
    });

    test(`never run is due`, () => {
        expect(verdictFor(report(), `standardize-patterns`).state).toBe(`due`);
    });

    test(`run inside the period is clear, and reports when it was read rather than claiming nothing to do`, () => {
        const daysAgo = 10;
        const verdict = verdictFor({ ...report(), ledger: [surveyLedger(NOW - daysAgo * DAY)] }, `standardize-patterns`);
        expect(verdict.state).toBe(`clear`);
        expect(verdict.headline).toContain(String(daysAgo));
    });

    test(`run longer ago than the cadence is due again`, () => {
        expect(verdictFor({ ...report(), ledger: [surveyLedger(NOW - 200 * DAY)] }, `standardize-patterns`).state).toBe(`due`);
    });
});

describe(`the badge speaks about transitions, not about statistics`, () => {
    const withAdvisories = report({ repos: [{ repo: `app`, probes: [auditProbe([`left-pad`])], signals: signals() }] });

    test(`acknowledging a digest silences it, and the next distinct finding still gets through`, () => {
        const first = verdictFor(withAdvisories, `security-advisories`);
        expect(unseenVerdicts([first], {})).toHaveLength(1);

        const seen = { [ledgerKey(`app`, `security-advisories`)]: first.digest };
        expect(unseenVerdicts([first], seen)).toEqual([]);

        const next = verdictFor(
            report({ repos: [{ repo: `app`, probes: [auditProbe([`left-pad`, `tar`])], signals: signals() }] }),
            `security-advisories`,
        );
        expect(unseenVerdicts([next], seen)).toHaveLength(1);
    });

    test(`a standing backlog of undocumented packages goes quiet once seen, but a new package speaks`, () => {
        const undocumented = (dirs: readonly string[]): ChoresReport =>
            report({
                repos: [{ repo: `app`, probes: [], signals: signals({ packages: dirs.map((dir) => pkg({ dir, name: dir, documented: false })) }) }],
            });

        const backlog = verdictFor(undocumented([`_libs/a`, `_libs/b`]), `documentation-refresh`);
        expect(backlog.state).toBe(`due`);
        const seen = { [ledgerKey(`app`, `documentation-refresh`)]: backlog.digest };
        expect(unseenVerdicts([backlog], seen)).toEqual([]);

        const grown = verdictFor(undocumented([`_libs/a`, `_libs/b`, `_libs/new`]), `documentation-refresh`);
        expect(unseenVerdicts([grown], seen)).toHaveLength(1);
    });
});

describe(`the findings themselves`, () => {
    test(`complexity reports only files that are load-bearing or out of proportion, never just the ranking's top`, () => {
        const hotspot = (path: string, complexity: number) => ({
            path,
            commits: 20,
            adds: 100,
            dels: 50,
            complexity,
            score: complexity * 20,
            latestMs: NOW,
        });
        // An even ranking has no outlier and no key module: a healthy repository, an empty finding.
        const even = report({
            repos: [{ repo: `app`, probes: [], signals: signals({ hotspots: [hotspot(`a.ts`, 30), hotspot(`b.ts`, 28), hotspot(`c.ts`, 26)] }) }],
        });
        expect(verdictFor(even, `complexity`).state).toBe(`clear`);

        const outlier = report({
            repos: [{ repo: `app`, probes: [], signals: signals({ hotspots: [hotspot(`a.ts`, 200), hotspot(`b.ts`, 28), hotspot(`c.ts`, 26)] }) }],
        });
        const verdict = verdictFor(outlier, `complexity`);
        expect(verdict.state).toBe(`due`);
        expect(verdict.detail).toHaveLength(1);
        expect(verdict.detail[0]).toContain(`a.ts`);
    });

    test(`a half-built index says nothing rather than ranking what it has read so far`, () => {
        const partial = report({
            repos: [
                {
                    repo: `app`,
                    probes: [],
                    signals: signals({
                        indexed: false,
                        hotspots: [{ path: `a.ts`, commits: 9, adds: 1, dels: 1, complexity: 900, score: 8100, latestMs: NOW }],
                    }),
                },
            ],
        });
        expect(verdictFor(partial, `complexity`).state).toBe(`clear`);
    });

    test(`two libraries for one job is the finding; one is not`, () => {
        const one = report({ repos: [{ repo: `app`, probes: [], signals: signals({ packages: [pkg({ dependencies: [`zod`] })] }) }] });
        expect(verdictFor(one, `library-overlap`).state).toBe(`clear`);

        const two = report({ repos: [{ repo: `app`, probes: [], signals: signals({ packages: [pkg({ dependencies: [`zod`, `yup`] })] }) }] });
        const verdict = verdictFor(two, `library-overlap`);
        expect(verdict.state).toBe(`due`);
        expect(verdict.detail[0]).toContain(`schema validation`);
    });

    test(`an unknown node major is not reported as end-of-life`, () => {
        expect(verdictFor({ ...report(), node: `v99.0.0` }, `runtime-eol`).state).toBe(`clear`);
    });

    test(`a runtime past its end-of-life date is the one ordinary finding that reaches warning`, () => {
        const verdict = verdictFor({ ...report(), node: `v18.20.0` }, `runtime-eol`);
        expect(verdict.state).toBe(`due`);
        expect(verdict.severity).toBe(`warning`);
    });

    test(`a supported runtime is clear`, () => {
        expect(verdictFor({ ...report(), node: `v24.18.0` }, `runtime-eol`).state).toBe(`clear`);
    });
});

describe(`the prompts`, () => {
    const dueVerdict = () =>
        verdictFor(report({ repos: [{ repo: `app`, probes: [auditProbe([`left-pad`])], signals: signals() }] }), `security-advisories`);

    test(`name the artefacts, not just how many there were`, () => {
        const verdict = dueVerdict();
        expect(verdict.prompt).toContain(`left-pad`);
        expect(verdict.prompt).toContain(`app`);
    });

    test(`tell an acting chore to keep the diff reviewable and a reporting chore not to edit at all`, () => {
        const acting = dueVerdict().prompt ?? ``;
        const survey = verdictFor(report(), `standardize-patterns`);
        expect(acting).toContain(`left-pad`);
        expect(acting).not.toBe(survey.prompt);
        expect(survey.prompt).not.toBe(acting);
    });

    test(`every chore that can be due can produce a prompt`, () => {
        const verdicts = assessReport(
            report({
                repos: [
                    {
                        repo: `app`,
                        probes: [
                            auditProbe([`left-pad`]),
                            probe({
                                id: `outdated`,
                                facts: {
                                    id: `outdated`,
                                    packages: [{ name: `vue`, current: `1.0.0`, latest: `2.0.0`, kind: `major`, section: `dependencies` }],
                                },
                            }),
                            probe({
                                id: `knip`,
                                facts: {
                                    id: `knip`,
                                    deadCode: { files: 3, exports: 2, types: 0, dependencies: 1, devDependencies: 0, sample: [`a.ts`] },
                                },
                            }),
                            probe({
                                id: `jscpd`,
                                facts: {
                                    id: `jscpd`,
                                    duplication: { percentage: 9, clones: 4, top: [{ lines: 20, first: `a.ts`, second: `b.ts` }] },
                                },
                            }),
                        ],
                        signals: signals({ packages: [pkg({ documented: false, dependencies: [`zod`, `joi`] })] }),
                    },
                ],
                node: `v18.20.0`,
            }),
            NOW,
        );
        const due = verdicts.filter((verdict) => verdict.state === `due`);
        expect(due.length).toBeGreaterThanOrEqual(8);
        for (const verdict of due) {
            expect(verdict.prompt, verdict.chore.id).toBeTypeOf(`string`);
            expect(verdict.digest, verdict.chore.id).not.toBe(``);
        }
        const promptFor = (chore: string) => due.find((verdict) => verdict.chore.id === chore)?.prompt ?? ``;
        expect(promptFor(`security-advisories`)).toContain(`left-pad`);
        expect(promptFor(`dependencies-outdated`)).toContain(`vue 1.0.0 → 2.0.0`);
        expect(promptFor(`dead-code`)).toContain(`a.ts`);
        expect(promptFor(`duplication`)).toContain(`a.ts ↔ b.ts`);
        expect(promptFor(`documentation-refresh`)).toContain(`_libs/thing`);
        expect(promptFor(`library-overlap`)).toContain(`zod`);
        expect(promptFor(`runtime-eol`)).toContain(`v18.20.0`);
    });
});

// Applicability: whether the chore is a question worth asking here, as against whether the answer is yes. Each
// case is a row the previous design could never act on (re-reading documentation that doesn't exist, slimming an image
// that isn't there).
describe(`what does not apply here`, () => {
    const withShape = (over: Partial<ChoreShape>): ChoresReport =>
        report({ repos: [{ repo: `app`, probes: [], signals: signals({ shape: shape(over) }) }] });

    test(`a repository with no documents is not asked to re-read its documentation`, () => {
        const verdict = verdictFor(withShape({ docs: [] }), `documentation-drift`);
        expect(verdict.state).toBe(`not-applicable`);
        expect(verdict.headline).toContain(`document`);
        expect(verdict.prompt).toBeUndefined();
    });

    test(`a repository with no Dockerfile is not asked to slim its image`, () => {
        expect(verdictFor(withShape({ dockerfiles: [] }), `docker-image`).state).toBe(`not-applicable`);
    });

    test(`a repository with no pipeline is not asked to tighten one`, () => {
        expect(verdictFor(withShape({ ci: [] }), `ci-hygiene`).state).toBe(`not-applicable`);
    });

    test(`a repository that is not a Node project is not offered the npm-shaped chores`, () => {
        const foreign = withShape({ packageManifest: false, lockfile: false });
        for (const chore of [`dependencies-outdated`, `runtime-eol`, `dead-code`, `security-advisories`, `deprecated-apis`]) {
            expect(verdictFor(foreign, chore).state, chore).toBe(`not-applicable`);
        }
    });

    test(`a repository that is not a workspace is not asked about per-package documents or library overlap`, () => {
        const single = report({ repos: [{ repo: `app`, probes: [], signals: signals({ packages: [] }) }] });
        expect(verdictFor(single, `documentation-refresh`).state).toBe(`not-applicable`);
        expect(verdictFor(single, `library-overlap`).state).toBe(`not-applicable`);
    });

    test(`a tiny repository is not surveyed for cross-cutting patterns it cannot have`, () => {
        const fileCount = 4;
        const tiny = report({
            repos: [{ repo: `app`, probes: [], signals: signals({ totals: { files: fileCount, symbols: 10, complexity: 5, hotspots: 0 } }) }],
        });
        const verdict = verdictFor(tiny, `standardize-patterns`);
        expect(verdict.state).toBe(`not-applicable`);
        expect(verdict.headline).toContain(String(fileCount));
    });

    test(`applicability is decided before measurement, so a missing probe never masks it`, () => {
        expect(verdictFor(withShape({ packageManifest: false }), `dead-code`).state).toBe(`not-applicable`);
    });

    test(`a chore that does not apply can never reach the rail`, () => {
        const verdicts = assessReport(withShape({ docs: [], dockerfiles: [], ci: [] }), NOW).filter((verdict) => verdict.state === `not-applicable`);
        expect(verdicts.length).toBeGreaterThanOrEqual(3);
        expect(unseenVerdicts(verdicts, {})).toEqual([]);
    });

    test(`a fully-equipped repository rules nothing out`, () => {
        expect(assessReport(withShape({}), NOW).filter((verdict) => verdict.state === `not-applicable`)).toEqual([]);
    });

    test(`applicability reasons are bare causes, so the ones that mean the same thing group`, () => {
        const bare = withShape({ packageManifest: false, lockfile: false, docs: [], ci: [], dockerfiles: [], deps: [] });
        const causes = assessReport(bare, NOW)
            .filter((verdict) => verdict.state === `not-applicable`)
            .map((verdict) => verdict.headline);
        for (const cause of causes) {
            expect(cause, cause).toMatch(/^[a-z]/);
            expect(cause.split(` `).length, cause).toBeLessThanOrEqual(4);
        }
        // Four chores are ruled out by one absent file; the strip says so once rather than four times.
        expect(causes.filter((cause) => cause === `no package.json`)).toHaveLength(4);
    });
});

// Four chores over two probes, tested where they decide something: the share that makes a bundle a finding, the
// names that make two components one, and the digests, since three of the four measure things that move on every markup
// edit.
const uiProbe = (scan: Partial<UiScan> = {}): ProbeResult =>
    probe({ id: `ui`, facts: { id: `ui`, scan: { components: [], bypasses: [], idioms: [], ...scan } } });

const bundleProbe = (assets: Bundle["assets"]): ProbeResult =>
    probe({
        id: `bundle`,
        facts: {
            id: `bundle`,
            bundle: {
                dir: `dist`,
                assets,
                totalBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
                totalGzip: assets.reduce((sum, asset) => sum + asset.gzip, 0),
            },
        },
    });

const jscpdProbe = (top: Duplication["top"]): ProbeResult =>
    probe({ id: `jscpd`, facts: { id: `jscpd`, duplication: { percentage: 1, clones: top.length, top } } });

const withProbes = (probes: readonly ProbeResult[], over: Partial<ChoreShape> = {}): ChoresReport =>
    report({ repos: [{ repo: `app`, probes: [...probes], signals: signals({ shape: shape(over) }) }] });

const chunk = (path: string, gzip: number): Bundle["assets"][number] => ({ path, bytes: gzip * 3, gzip });

describe(`what the browser downloads`, () => {
    test(`one chunk over half the transfer is the finding, and the headline names it`, () => {
        const verdict = verdictFor(
            withProbes([bundleProbe([chunk(`dist/vendor-DlAUqK2U.js`, 800), chunk(`dist/index-a1.js`, 100), chunk(`dist/s-b2.css`, 50)])]),
            `bundle-weight`,
        );
        expect(verdict.state).toBe(`due`);
        expect(verdict.headline).toContain(`dist/vendor-DlAUqK2U.js`);
        expect(verdict.headline).toContain(`84%`);
    });

    test(`a build that is actually split says nothing`, () => {
        const even = [chunk(`dist/a-1.js`, 100), chunk(`dist/b-2.js`, 100), chunk(`dist/c-3.js`, 100), chunk(`dist/d-4.js`, 100)];
        expect(verdictFor(withProbes([bundleProbe(even)]), `bundle-weight`).state).toBe(`clear`);
    });

    test(`too few assets to have a shape is clear, not due`, () => {
        expect(verdictFor(withProbes([bundleProbe([chunk(`dist/a-1.js`, 900), chunk(`dist/b-2.js`, 10)])]), `bundle-weight`).state).toBe(`clear`);
    });

    test(`rebuilding the same code does not read as new evidence`, () => {
        const before = verdictFor(
            withProbes([bundleProbe([chunk(`dist/vendor-DlAUqK2U.js`, 800), chunk(`dist/index-a1b2c3d4.js`, 100), chunk(`dist/s.css`, 50)])]),
            `bundle-weight`,
        );
        const after = verdictFor(
            withProbes([bundleProbe([chunk(`dist/vendor-Zq99XxYw.js`, 802), chunk(`dist/index-9z8y7x6w.js`, 101), chunk(`dist/s.css`, 50)])]),
            `bundle-weight`,
        );
        expect(after.digest).toBe(before.digest);
    });

    test(`a genuinely different chunk appearing does`, () => {
        const before = verdictFor(
            withProbes([bundleProbe([chunk(`dist/vendor-DlAUqK2U.js`, 800), chunk(`dist/index-a1b2c3d4.js`, 100), chunk(`dist/s.css`, 50)])]),
            `bundle-weight`,
        );
        const after = verdictFor(
            withProbes([bundleProbe([chunk(`dist/vendor-DlAUqK2U.js`, 800), chunk(`dist/charting-a1b2c3d4.js`, 100), chunk(`dist/s.css`, 50)])]),
            `bundle-weight`,
        );
        expect(after.digest).not.toBe(before.digest);
    });
});

describe(`idioms the framework has replaced`, () => {
    const idioms = (id: string, count: number) => ({ id, files: Array.from({ length: count }, (_, index) => `src/C${index}.vue`) });

    test(`names what is still in use and what replaced it`, () => {
        const verdict = verdictFor(withProbes([uiProbe({ idioms: [idioms(`vue-options-api`, 3)] })]), `framework-idiom`);
        expect(verdict.state).toBe(`due`);
        expect(verdict.detail[0]).toContain(`3 files`);
        expect(verdict.detail[0]).toContain(`Options API`);
        expect(verdict.detail[0]).toContain(`script setup`);
    });

    test(`one more file in a large migration is not news`, () => {
        const before = verdictFor(withProbes([uiProbe({ idioms: [idioms(`vue-options-api`, 40)] })]), `framework-idiom`);
        const after = verdictFor(withProbes([uiProbe({ idioms: [idioms(`vue-options-api`, 41)] })]), `framework-idiom`);
        expect(after.digest).toBe(before.digest);
    });

    test(`a kind of legacy code the repository did not have before is`, () => {
        const before = verdictFor(withProbes([uiProbe({ idioms: [idioms(`vue-options-api`, 40)] })]), `framework-idiom`);
        const after = verdictFor(withProbes([uiProbe({ idioms: [idioms(`vue-options-api`, 40), idioms(`vue-global-api`, 1)] })]), `framework-idiom`);
        expect(after.digest).not.toBe(before.digest);
    });

    test(`an idiom this build of the book does not know is dropped, not shown unnamed`, () => {
        expect(verdictFor(withProbes([uiProbe({ idioms: [idioms(`react-from-2029`, 5)] })]), `framework-idiom`).state).toBe(`clear`);
    });

    test(`an idiom from a framework the repository does not declare is not its problem`, () => {
        const vue = withProbes([uiProbe({ idioms: [idioms(`angular-ngmodule`, 4)] })], { deps: [`vue`] });
        const angular = withProbes([uiProbe({ idioms: [idioms(`angular-ngmodule`, 4)] })], { deps: [`@angular/core`] });
        expect(verdictFor(vue, `framework-idiom`).state).toBe(`clear`);
        expect(verdictFor(angular, `framework-idiom`).state).toBe(`due`);
    });
});

describe(`components built twice`, () => {
    const components = (...paths: readonly string[]) => uiProbe({ components: [...paths] });

    test(`a shared name across two directories is a family, whatever each file is called`, () => {
        const verdict = verdictFor(
            withProbes([components(`src/ui/BaseButton.vue`, `src/checkout/ButtonV2.tsx`), jscpdProbe([])]),
            `component-overlap`,
        );
        expect(verdict.state).toBe(`due`);
        expect(verdict.headline).toContain(`1 name`);
        expect(verdict.detail[0]).toContain(`button`);
        expect(verdict.detail[0]).toContain(`ButtonV2.tsx`);
    });

    test(`components that merely coexist are not a finding`, () => {
        expect(verdictFor(withProbes([components(`src/Button.vue`, `src/Card.vue`), jscpdProbe([])]), `component-overlap`).state).toBe(`clear`);
    });

    test(`a clone counts only when a component sits on both sides of it`, () => {
        const ui = components(`src/Chart.vue`, `src/Graph.vue`);
        const shared = verdictFor(
            withProbes([ui, jscpdProbe([{ lines: 40, first: `./src/Chart.vue`, second: `./src/Graph.vue` }])]),
            `component-overlap`,
        );
        const oneSided = verdictFor(
            withProbes([ui, jscpdProbe([{ lines: 40, first: `./src/Chart.vue`, second: `./src/utils/format.ts` }])]),
            `component-overlap`,
        );
        expect(shared.state).toBe(`due`);
        expect(shared.headline).toContain(`clone`);
        expect(oneSided.state).toBe(`clear`);
    });

    test(`without the clone sweep the chore is unavailable, not clear`, () => {
        expect(verdictFor(withProbes([components(`src/Button.vue`, `src/ui/Button.vue`)]), `component-overlap`).state).toBe(`unavailable`);
    });
});

describe(`hard-coded styles`, () => {
    test(`counts the values and leads with the heaviest files`, () => {
        const verdict = verdictFor(
            withProbes([
                uiProbe({
                    bypasses: [
                        { path: `src/Checkout.vue`, count: 11 },
                        { path: `src/Nav.vue`, count: 2 },
                    ],
                }),
            ]),
            `tailwind-arbitrary-values`,
        );
        expect(verdict.state).toBe(`due`);
        expect(verdict.headline).toContain(`13`);
        expect(verdict.headline).toContain(`2 files`);
        expect(verdict.detail[0]).toContain(`Checkout.vue`);
        expect(verdict.detail[0]).toContain(`11`);
    });

    test(`a repository without Tailwind is not asked the question at all`, () => {
        const verdict = verdictFor(
            withProbes([uiProbe({ bypasses: [{ path: `src/Nav.vue`, count: 2 }] })], { deps: [`vue`] }),
            `tailwind-arbitrary-values`,
        );
        expect(verdict.state).toBe(`not-applicable`);
        expect(verdict.headline).toContain(`Tailwind`);
    });

    // The framework gate all four share reads `deps` from shape, not from `packages`: a single-package app has no
    // workspace packages at all.
    test(`a repository with no framework rules the front-end chores out entirely`, () => {
        const states = [`bundle-weight`, `framework-idiom`, `component-overlap`, `tailwind-arbitrary-values`].map(
            (id) => verdictFor(withProbes([], { deps: [`pino`] }), id).state,
        );
        expect(states).toEqual([`not-applicable`, `not-applicable`, `not-applicable`, `not-applicable`]);
    });
});

// The second axis: has anyone already answered this, and does the answer still stand; what the panel demotes on
// (mark, tint, counts) has to match this exactly.
describe(`whether a chore has already been answered`, () => {
    const withAdvisories = report({ repos: [{ repo: `app`, probes: [auditProbe([`left-pad`])], signals: signals() }] });
    const ledgerEntry = (over: Partial<ChoreLedgerEntry> = {}): ChoreLedgerEntry => ({
        repo: `app`,
        chore: `security-advisories`,
        ranAt: NOW - DAY,
        runId: `r1`,
        outcome: `reported`,
        digest: verdictFor(withAdvisories, `security-advisories`).digest,
        ...over,
    });

    test(`a settled chore carries its answer, and the answer stands`, () => {
        const verdict = verdictFor({ ...withAdvisories, ledger: [ledgerEntry()] }, `security-advisories`);
        expect(verdict.state).toBe(`due`);
        expect(choreAnswer(verdict)).toEqual({ outcome: `reported`, ranAt: NOW - DAY });
        expect(choreAnswered(verdict)).toBe(true);
    });

    test(`a stale chore carries its answer too`, () => {
        const verdict = verdictFor({ ...withAdvisories, ledger: [ledgerEntry({ ranAt: NOW - 3_600_000, outcome: `acted` })] }, `security-advisories`);
        expect(verdict.state).toBe(`stale`);
        expect(choreAnswer(verdict)?.outcome).toBe(`acted`);
        expect(choreAnswered(verdict)).toBe(true);
    });

    test(`a stale chore with nothing to show is still nothing to start`, () => {
        const verdict = verdictFor(
            { ...withAdvisories, ledger: [ledgerEntry({ ranAt: NOW - 3_600_000, digest: `answered-something-else` })] },
            `security-advisories`,
        );
        expect(verdict.state).toBe(`stale`);
        expect(verdict.prompt).toBeUndefined();
        expect(choreAnswer(verdict)).toBeUndefined();
        expect(choreAnswered(verdict)).toBe(true);
    });

    test(`a run against evidence that has since moved has answered nothing`, () => {
        const moved = report({
            repos: [{ repo: `app`, probes: [auditProbe([`left-pad`, `minimist`])], signals: signals() }],
            ledger: [ledgerEntry()],
        });
        const verdict = verdictFor(moved, `security-advisories`);
        expect(verdict.state).toBe(`due`);
        expect(choreAnswer(verdict)).toBeUndefined();
        expect(choreAnswered(verdict)).toBe(false);
    });

    test(`a lapsed chore still shows what was concluded, and no longer counts as answered`, () => {
        const dependencies = choreById(`dependencies-outdated`);
        expect(dependencies?.cadenceMs).toBeGreaterThan(0);
        const lapsedAt = NOW - (dependencies?.cadenceMs ?? 0) - DAY;

        const outdatedProbe = probe({
            id: `outdated`,
            facts: { id: `outdated`, packages: [{ name: `vue`, current: `1.0.0`, latest: `2.0.0`, kind: `major`, section: `dependencies` }] },
        });
        const repos = [{ repo: `app`, probes: [outdatedProbe], signals: signals() }];
        // The digest comes from the verdict itself, not a transcription, so this stays a test about the cadence, not a
        // mismatched fingerprint.
        const digest = verdictFor(report({ repos }), `dependencies-outdated`).digest;
        const entry: ChoreLedgerEntry = { repo: `app`, chore: `dependencies-outdated`, ranAt: lapsedAt, runId: `r0`, outcome: `acted`, digest };

        const verdict = verdictFor(report({ repos, ledger: [entry] }), `dependencies-outdated`);
        expect(verdict.state).toBe(`due`);
        // Same evidence: the run did answer this; only the cadence lapsing asks again.
        expect(verdict.settled).toBe(false);
        expect(choreAnswer(verdict)?.outcome).toBe(`acted`);
        expect(choreAnswered(verdict)).toBe(false);
    });

    test(`a row with no finding of its own has no answer`, () => {
        const clear = verdictFor(report({ repos: [{ repo: `app`, probes: [auditProbe([])], signals: signals() }], ledger: [ledgerEntry()] }), `security-advisories`);
        expect(clear.state).toBe(`clear`);
        expect(clear.digest).toBe(``);
        expect(choreAnswer(clear)).toBeUndefined();
    });
});

// The criterion: the rule in words beside the evidence that met it. A row reporting a number without it is
// asking to be trusted, and one wrong row costs the list its credibility.
describe(`every chore says what would make it due`, () => {
    test(`every entry in the book carries a criterion`, () => {
        for (const chore of CHORES) {
            expect(chore.criterion, chore.id).toBeTypeOf(`string`);
            expect(chore.criterion.length, chore.id).toBeGreaterThan(20);
        }
    });

    test(`the criterion reaches the prompt, so the agent can tell us the rule was wrong`, () => {
        const due = verdictFor(report({ repos: [{ repo: `app`, probes: [auditProbe([`left-pad`])], signals: signals() }] }), `security-advisories`);
        expect(due.prompt).toContain(due.chore.criterion);
    });
});
