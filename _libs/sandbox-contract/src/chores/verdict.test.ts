import type { ChoreLedgerEntry, ChorePackage, ChoresReport, ChoreSignals, ProbeResult } from "../schemas.js";
import { describe, expect, test } from "vitest";
import { choreById } from "./chores.js";
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

const signals = (over: Partial<ChoreSignals> = {}): ChoreSignals => ({
    packages: [pkg()],
    hotspots: [],
    keyModules: [],
    totals: { files: 10, symbols: 100, complexity: 90, hotspots: 0 },
    indexed: true,
    ...over,
});

const probe = (over: Partial<ProbeResult> & Pick<ProbeResult, "id">): ProbeResult => ({ state: `ok`, ranAt: NOW - DAY, tookMs: 1000, ...over });

const auditProbe = (names: readonly string[]): ProbeResult =>
    probe({
        id: `audit`,
        facts: { id: `audit`, advisories: names.map((name) => ({ name, severity: `high` as const, title: `${name} is bad`, patched: `>=2`, dev: false })) },
    });

const report = (over: Partial<ChoresReport> = {}): ChoresReport => ({ repos: [{ repo: `app`, probes: [], signals: signals() }], ledger: [], node: `v24.18.0`, ...over });

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
            repos: [{ repo: `app`, probes: [probe({ id: `knip`, state: `unavailable`, reason: `knip is not a devDependency` })], signals: signals() }],
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

    test(`a run against this exact evidence leaves the chore due but settled — shown, never badged`, () => {
        const verdict = verdictFor({ ...withAdvisories, ledger: [ledgerEntry()] }, `security-advisories`);
        expect(verdict.state).toBe(`due`);
        expect(verdict.settled).toBe(true);
        expect(unseenVerdicts([verdict], {})).toEqual([]);
    });

    // The point of digesting evidence rather than stamping a time: a fix landing, or a NEW advisory arriving,
    // both move the evidence and both deserve to be heard again.
    test(`evidence that has moved since the run is unsettled again`, () => {
        const moved = report({ repos: [{ repo: `app`, probes: [auditProbe([`left-pad`, `minimist`])], signals: signals() }], ledger: [ledgerEntry()] });
        const verdict = verdictFor(moved, `security-advisories`);
        expect(verdict.state).toBe(`due`);
        expect(verdict.settled).toBe(false);
        expect(unseenVerdicts([verdict], {})).toHaveLength(1);
    });

    test(`an agent reporting the findings did not hold up clears the chore until the evidence changes`, () => {
        const verdict = verdictFor({ ...withAdvisories, ledger: [ledgerEntry({ outcome: `clean` })] }, `security-advisories`);
        expect(verdict.state).toBe(`clear`);
        expect(verdict.headline).toBe(`Checked — the findings did not hold up`);
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
     * for good. Security has no cadence on purpose — an advisory does not become interesting again because
     * ninety days passed, it becomes interesting when the advisory set changes — so its settlement persists. */
    test(`settlement expires with the chore's cadence, and persists for the chores that have none`, () => {
        const dependencies = choreById(`dependencies-outdated`);
        expect(dependencies?.cadenceMs).toBeGreaterThan(0);
        expect(choreById(`security-advisories`)?.cadenceMs).toBe(0);

        const old = { ...withAdvisories, ledger: [ledgerEntry({ ranAt: NOW - 400 * DAY })] };
        expect(verdictFor(old, `security-advisories`).settled).toBe(true);
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

        const next = verdictFor(report({ repos: [{ repo: `app`, probes: [auditProbe([`left-pad`, `tar`])], signals: signals() }] }), `security-advisories`);
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
        const hotspot = (path: string, complexity: number) => ({ path, commits: 20, adds: 100, dels: 50, complexity, score: complexity * 20, latestMs: NOW });
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
                    signals: signals({ indexed: false, hotspots: [{ path: `a.ts`, commits: 9, adds: 1, dels: 1, complexity: 900, score: 8100, latestMs: NOW }] }),
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
    const dueVerdict = () => verdictFor(report({ repos: [{ repo: `app`, probes: [auditProbe([`left-pad`])], signals: signals() }] }), `security-advisories`);

    /* A prompt that counts without NAMING sends the agent off to re-derive a list we are already holding — slowly,
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
                            probe({ id: `outdated`, facts: { id: `outdated`, packages: [{ name: `vue`, current: `1.0.0`, latest: `2.0.0`, kind: `major`, section: `dependencies` }] } }),
                            probe({ id: `knip`, facts: { id: `knip`, deadCode: { files: 3, exports: 2, types: 0, dependencies: 1, devDependencies: 0, sample: [`a.ts`] } } }),
                            probe({ id: `jscpd`, facts: { id: `jscpd`, duplication: { percentage: 9, clones: 4, top: [{ lines: 20, first: `a.ts`, second: `b.ts` }] } } }),
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
        // Each measured chore's own artefact reaches its own prompt — the regression this whole test exists for.
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
