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
import { assessReport, ledgerKey, unseenVerdicts } from "./verdict.js";

/* The state machine, tested at the distinctions it exists to draw. Every case below is one that a simpler design
 * gets wrong in a way that costs the surface its credibility: reporting a repository clean that was never
 * measured, badging the same finding every hour while its fix sits in review, letting a snooze become a
 * permanent silence, or letting an agent's "these were false positives" be forgotten by the next poll. */

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

// A repository that is a Node workspace with documents, a pipeline, an image and a Tailwind front-end, so every
// chore APPLIES by default and each applicability test can turn off exactly the one fact it is about.
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
    // Verdicts are about EVIDENCE, never about work in flight: a probe running does not make a chore more or
    // less due, it only makes the panel say so. Empty here because no assertion in this file should depend on it.
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
        expect(verdict.detail).toEqual([`Security advisories · not measured yet`]);
    });

    // The distinction that stops the panel reporting a green repository it has never looked at. A tool the repo
    // does not have is not evidence of anything, and it carries the tool's own reason rather than an invented one.
    test(`a probe the repository cannot run says so, and never badges`, () => {
        const input = report({
            repos: [
                { repo: `app`, probes: [probe({ id: `knip`, state: `unavailable`, reason: `knip is not a devDependency` })], signals: signals() },
            ],
        });
        const verdict = verdictFor(input, `dead-code`);
        expect(verdict.state).toBe(`unavailable`);
        expect(verdict.detail[0]).toContain(`knip is not a devDependency`);
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

    // The point of digesting evidence rather than stamping a time: a fix landing, or a NEW advisory arriving,
    // both move the evidence and both deserve to be heard again.
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
        const verdict = verdictFor({ ...withAdvisories, ledger: [ledgerEntry({ outcome: `clean` })] }, `security-advisories`);
        expect(verdict.state).toBe(`clear`);
        expect(verdict.headline).toBe(`Checked, the findings did not hold up`);
    });

    test(`a snooze silences a due chore without hiding it, and lapses on its own`, () => {
        const snoozed = verdictFor({ ...withAdvisories, ledger: [ledgerEntry({ snoozedUntil: NOW + DAY })] }, `security-advisories`);
        expect(snoozed.state).toBe(`snoozed`);
        expect(snoozed.detail).not.toEqual([]);
        expect(unseenVerdicts([snoozed], {})).toEqual([]);

        const lapsed = verdictFor({ ...withAdvisories, ledger: [ledgerEntry({ snoozedUntil: NOW - 1 })] }, `security-advisories`);
        expect(lapsed.state).toBe(`due`);
    });

    /* A chore with a cadence expires its own settlement, so "we looked and chose not to act" cannot silence it
     * for good. Security has no cadence on purpose: an advisory does not become interesting again because
     * ninety days passed, it becomes interesting when the advisory set changes, so its settlement persists. */
    test(`settlement expires with the chore's cadence, and persists for the chores that have none`, () => {
        const dependencies = choreById(`dependencies-outdated`);
        expect(dependencies?.cadenceMs).toBeGreaterThan(0);
        expect(choreById(`security-advisories`)?.cadenceMs).toBe(0);

        const old = { ...withAdvisories, ledger: [ledgerEntry({ ranAt: NOW - 400 * DAY })] };
        expect(verdictFor(old, `security-advisories`).settled).toBe(true);
    });
});

/* The distinction the digest alone cannot draw, and the one whose absence had the panel quoting a six-day-old
 * dead-code count an hour after the turn that deleted it. An unchanged digest is what a probe that never re-ran
 * produces, so "the fix did not move the numbers" and "we have not looked since the fix" reached the same branch
 * and both came out as a confident `due`. */
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

    // The probe ran a day ago; the turn started an hour ago. Whatever it did, nothing has looked since.
    test(`a turn that landed after the measurement steps the chore down from due`, () => {
        const verdict = verdictFor({ ...withAdvisories, ledger: [ledgerEntry({ ranAt: NOW - 3_600_000 })] }, `security-advisories`);
        expect(verdict.state).toBe(`stale`);
        // The evidence stays on the row: it is what the reader checks the claim against, and the claim comes off.
        expect(verdict.detail).not.toEqual([]);
        expect(verdict.settled).toBe(false);
    });

    // No prompt, so the row cannot offer to spend a second turn on a finding nobody has re-checked; and no badge,
    // which is what stops the tile lighting for work that is already done.
    test(`a stale chore offers no turn and never badges`, () => {
        const verdict = verdictFor({ ...withAdvisories, ledger: [ledgerEntry({ ranAt: NOW - 3_600_000 })] }, `security-advisories`);
        expect(verdict.prompt).toBeUndefined();
        expect(unseenVerdicts([verdict], {})).toEqual([]);
    });

    // Re-measuring is the whole cure: the same run, against evidence taken after it, is settled rather than stale.
    test(`re-measuring after the turn restores the verdict: due, and now genuinely settled`, () => {
        const remeasured = report({
            repos: [{ repo: `app`, probes: [{ ...auditProbe([`left-pad`]), ranAt: NOW - 60_000 }], signals: signals() }],
            ledger: [ledgerEntry({ ranAt: NOW - 3_600_000 })],
        });
        const verdict = verdictFor(remeasured, `security-advisories`);
        expect(verdict.state).toBe(`due`);
        expect(verdict.settled).toBe(true);
    });

    // The agent's own "these were false positives" is a judgement about the live tree, made after the measurement.
    // It outranks staleness, or every clean run would be re-opened by the very probe age it was reported against.
    test(`an agent reporting the findings did not hold up still clears the chore`, () => {
        const verdict = verdictFor({ ...withAdvisories, ledger: [ledgerEntry({ ranAt: NOW - 3_600_000, outcome: `clean` })] }, `security-advisories`);
        expect(verdict.state).toBe(`clear`);
    });

    // A snooze is the owner speaking, and it outranks both.
    test(`a snooze still wins`, () => {
        const verdict = verdictFor(
            { ...withAdvisories, ledger: [ledgerEntry({ ranAt: NOW - 3_600_000, snoozedUntil: NOW + DAY })] },
            `security-advisories`,
        );
        expect(verdict.state).toBe(`snoozed`);
    });

    // Every measured row carries when it was taken, so no row can pass off a week-old count as this morning's.
    test(`every measured verdict says when it was measured, and the unmeasurable ones say nothing`, () => {
        expect(verdictFor(withAdvisories, `security-advisories`).measuredAt).toBe(NOW - DAY);
        // A survey rests on no measurement: it is decided by the calendar, and has nothing to be out of date.
        expect(verdictFor(report(), `standardize-patterns`).measuredAt).toBeUndefined();
        // Nor does a probe that never ran.
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
        const verdict = verdictFor({ ...report(), ledger: [surveyLedger(NOW - 10 * DAY)] }, `standardize-patterns`);
        expect(verdict.state).toBe(`clear`);
        expect(verdict.headline).toBe(`Surveyed 10 days ago`);
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

    // The rule the whole surface is built to satisfy: a backlog that has been seen once must stop speaking, or
    // the tile is lit every day and the rail stops being read at all.
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
        // An even ranking has no outlier and no key module in it: a healthy repository, and an empty finding.
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

    // The runtime table is static and offline by design; a major it does not know about must read as "not
    // end-of-life", which is the safe direction to be wrong in.
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

    /* A prompt that counts without NAMING sends the agent off to re-derive a list we are already holding: slowly,
     * and against a tree that has moved since. Every measured chore names its artefacts. */
    test(`name the artefacts, not just how many there were`, () => {
        const verdict = dueVerdict();
        expect(verdict.prompt).toContain(`left-pad`);
        expect(verdict.prompt).toContain(`app`);
    });

    test(`tell an acting chore to keep the diff reviewable and a reporting chore not to edit at all`, () => {
        expect(dueVerdict().prompt).toContain(`separately explainable`);
        const survey = verdictFor(report(), `standardize-patterns`);
        expect(survey.prompt).toContain(`Change nothing.`);
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
        // Each measured chore's own artefact reaches its own prompt: the regression this whole test exists for.
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

/* APPLICABILITY, whether the chore is a QUESTION worth asking of this repository, as opposed to whether the
 * answer is yes. Every case here is one where the previous design showed a row that could never be acted on:
 * an offer to re-read documentation that was never written, to slim an image that does not exist, to tighten a
 * pipeline nobody has. Each of those teaches the reader that this list was not written by someone who looked. */
describe(`what does not apply here`, () => {
    const withShape = (over: Partial<ChoreShape>): ChoresReport =>
        report({ repos: [{ repo: `app`, probes: [], signals: signals({ shape: shape(over) }) }] });

    test(`a repository with no documents is not asked to re-read its documentation`, () => {
        const verdict = verdictFor(withShape({ docs: [] }), `documentation-drift`);
        expect(verdict.state).toBe(`not-applicable`);
        expect(verdict.headline).toBe(`no architecture documents`);
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

    // A survey has no evidence to be absent: "90 days have passed" is true everywhere, so without a gate it
    // fires forever in repositories where its subject does not exist. This is the regression that motivated
    // making `applies` a required field on SurveySpec rather than an optional one.
    test(`a tiny repository is not surveyed for cross-cutting patterns it cannot have`, () => {
        const tiny = report({
            repos: [{ repo: `app`, probes: [], signals: signals({ totals: { files: 4, symbols: 10, complexity: 5, hotspots: 0 } }) }],
        });
        const verdict = verdictFor(tiny, `standardize-patterns`);
        expect(verdict.state).toBe(`not-applicable`);
        expect(verdict.headline).toBe(`only 4 indexed files`);
    });

    test(`applicability is decided before measurement, so a missing probe never masks it`, () => {
        // dead-code needs the knip probe, which has not run; the gate still wins, because "we cannot ask this
        // question here" outranks "we have not measured it".
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

    /* THE CAUSES HAVE TO GROUP, and that is a fact about the STRINGS rather than about the gates. The scope strip
     * prints one line per distinct cause with the chores it costs listed beside it, so two gates that both mean
     * "there is no package.json here" and say it in different words print two lines, and a workspace root, where
     * a dozen chores are ruled out by three facts, is back to the paragraph-per-chore wall this phrasing replaced.
     * Bounded rather than enumerated: a new gate may invent a new cause, it may not invent a new sentence. */
    test(`applicability reasons are bare causes, so the ones that mean the same thing group`, () => {
        const bare = withShape({ packageManifest: false, lockfile: false, docs: [], ci: [], dockerfiles: [], deps: [] });
        const causes = assessReport(bare, NOW)
            .filter((verdict) => verdict.state === `not-applicable`)
            .map((verdict) => verdict.headline);
        for (const cause of causes) {
            expect(cause, cause).toMatch(/^[a-z]/);
            expect(cause.split(` `).length, cause).toBeLessThanOrEqual(4);
        }
        // Four chores are ruled out by ONE absent file, and the strip says so once rather than four times.
        expect(causes.filter((cause) => cause === `no package.json`)).toHaveLength(4);
    });
});

/* THE FRONT-END CHORES. Four chores over two probes, tested where they decide something: the share that makes a
 * bundle a finding, the names that make two components one component, and above all the digests, because three of
 * these four measure things that move every time anyone writes a line of markup. */
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

    // Two files cannot tell you how a build is divided, and the larger of them is over half by arithmetic.
    test(`too few assets to have a shape is clear, not due`, () => {
        expect(verdictFor(withProbes([bundleProbe([chunk(`dist/a-1.js`, 900), chunk(`dist/b-2.js`, 10)])]), `bundle-weight`).state).toBe(`clear`);
    });

    /* THE CASE THIS CHORE WOULD OTHERWISE FAIL EVERY DAY. A content hash changing is what a content hash is for,
     * so rebuilding identical code renames every asset. Digesting the raw paths would mint new evidence on every
     * `pnpm build` and badge forever while reporting nothing new. */
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
        expect(verdict.detail).toEqual([`3 files · the Options API → <script setup> with the Composition API`]);
    });

    /* A migration in progress is a set that changes on every commit, so digesting the file identities, which is
     * right for the documentation chore, whose set is packages: would badge continuously through exactly the
     * period someone is doing the work. The bucketed count moves on real progress and not on daily churn. */
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

    // The daemon composes the sweep from its own copy of the table, so an image ahead of the browser can report a
    // rule this build has no label or replacement for. A row about it could say nothing useful.
    test(`an idiom this build of the book does not know is dropped, not shown unnamed`, () => {
        expect(verdictFor(withProbes([uiProbe({ idioms: [idioms(`react-from-2029`, 5)] })]), `framework-idiom`).state).toBe(`clear`);
    });

    /* A probe's command is a fixed string, so every rule sweeps every repository and the Angular patterns get
     * their chance in a Vue codebase. Run against this workspace it found one file: the rule table itself, which
     * quotes `RouterModule.forRoot` as a pattern. What the repository declares is what settles it. */
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
        expect(verdict.headline).toBe(`1 name used by more than one component`);
        expect(verdict.detail).toEqual([`button · src/checkout/ButtonV2.tsx, src/ui/BaseButton.vue`]);
    });

    test(`components that merely coexist are not a finding`, () => {
        expect(verdictFor(withProbes([components(`src/Button.vue`, `src/Card.vue`), jscpdProbe([])]), `component-overlap`).state).toBe(`clear`);
    });

    // The other half of the evidence: two components with unrelated names doing the same work, which no name
    // comparison can reach and jscpd already measured.
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
        expect(shared.headline).toBe(`1 clone spanning two of them`);
        expect(oneSided.state).toBe(`clear`);
    });

    /* Half a measurement would let the row claim it looked for shared logic in a repository where jscpd has never
     * run: the "measured and found nothing" lie the unavailable state exists to prevent. */
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
        expect(verdict.headline).toBe(`13 hard-coded values across 2 files`);
        expect(verdict.detail[0]).toBe(`src/Checkout.vue · 11 values`);
    });

    // Tailwind gates this one alone: a Vue repository with no Tailwind has no theme scale to have bypassed, and
    // a row saying so would be the surface inventing a subject.
    test(`a repository without Tailwind is not asked the question at all`, () => {
        const verdict = verdictFor(
            withProbes([uiProbe({ bypasses: [{ path: `src/Nav.vue`, count: 2 }] })], { deps: [`vue`] }),
            `tailwind-arbitrary-values`,
        );
        expect(verdict.state).toBe(`not-applicable`);
        expect(verdict.headline).toBe(`no Tailwind`);
    });

    // And the framework gate the other four share, from the other side: deps come from shape, not from packages,
    // because a single-package Vite app has no workspace packages at all.
    test(`a repository with no framework rules the front-end chores out entirely`, () => {
        const states = [`bundle-weight`, `framework-idiom`, `component-overlap`, `tailwind-arbitrary-values`].map(
            (id) => verdictFor(withProbes([], { deps: [`pino`] }), id).state,
        );
        expect(states).toEqual([`not-applicable`, `not-applicable`, `not-applicable`, `not-applicable`]);
    });
});

/* THE CRITERION: the rule in words, next to the evidence that met it. A row that reports a number without the
 * rule behind it is asking to be taken on trust, and the first row that turns out to be wrong costs the whole
 * list its credibility. */
describe(`every chore says what would make it due`, () => {
    test(`every entry in the book carries a criterion`, () => {
        for (const chore of CHORES) {
            expect(chore.criterion, chore.id).toBeTypeOf(`string`);
            expect(chore.criterion.length, chore.id).toBeGreaterThan(20);
        }
    });

    test(`the criterion reaches the prompt, so the agent can tell us the rule was wrong`, () => {
        const due = verdictFor(report({ repos: [{ repo: `app`, probes: [auditProbe([`left-pad`])], signals: signals() }] }), `security-advisories`);
        expect(due.prompt).toContain(`You were woken because:`);
        expect(due.prompt).toContain(due.chore.criterion);
    });
});
