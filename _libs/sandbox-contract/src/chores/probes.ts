import type { Advisory, DeadCode, Duplication, OutdatedPackage, ProbeFacts, ProbeId } from "../schemas.js";

/* THE PROBES — the measurements that cost a subprocess, declared once so the daemon that runs them and the panel
 * that explains them cannot disagree about what "outdated" meant.
 *
 * A spec is a shell command and a parser, deliberately in that order of trust: the command is whatever the tool's
 * own maintainers publish as its machine-readable output, and the parser is written to be DISAPPOINTED. Every one
 * of these tools has changed its JSON shape at least once, they are run against whatever version the repo pinned,
 * and a probe that throws on an unexpected field would take the whole maintenance surface down with it. So each
 * parser walks the structure defensively and returns `undefined` when it cannot recognise what it got — which the
 * runner records as a failed probe with the output attached, rather than as a clean repository.
 *
 * TIERS ARE ABOUT COST, and the cost is what sets the cadence. Tier 1 reads metadata that already exists (a
 * lockfile, a registry's version list) and finishes in seconds, so the background runner refreshes it daily. Tier
 * 2 reads the whole tree — knip type-checks it, jscpd tokenizes every file — and can run for minutes on a large
 * repo, so it refreshes weekly and says how long it took, because a reader deciding whether to force a refresh
 * deserves to know what they are asking for.
 *
 * THE `available` COMMAND IS NOT AN AFTERTHOUGHT. "knip is not a devDependency of this repo" and "knip found no
 * dead code" are opposite facts that a bare exit code cannot tell apart, and collapsing them is how a maintenance
 * panel ends up reporting a green repository it has never measured. Non-zero here means unmeasured, and an
 * unmeasured chore renders greyed and can never light the rail. */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface ProbeSpec {
    readonly id: ProbeId;
    readonly title: string;
    // What the reader is told this measures, in the panel, next to its age.
    readonly measures: string;
    readonly tier: 1 | 2;
    // How long a result stays fresh. The background runner refreshes anything older; the panel's per-probe
    // refresh button ignores it.
    readonly ttlMs: number;
    readonly timeoutMs: number;
    // Exit 0 ⇒ this repo can be measured. Runs in the repo's own directory, like the command.
    readonly available: string;
    // `sh -c`, in the repo's directory. Stdout is the parser's input; a non-zero exit is NOT a failure by itself
    // (pnpm outdated and pnpm audit both exit non-zero precisely when they have something to report), so the
    // runner judges by whether the parser recognised the output.
    readonly command: string;
    readonly parse: (stdout: string) => ProbeFacts | undefined;
}

// A parsed JSON object, or undefined for anything else. Every parser starts here, so "the tool printed a warning
// before its JSON" and "the tool printed nothing" both land on the same honest answer instead of throwing.
const asObject = (text: string): Record<string, unknown> | undefined => {
    const start = text.indexOf(`{`);
    if (start === -1) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(text.slice(start));
        return typeof parsed === `object` && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
};

const asString = (value: unknown): string | undefined => (typeof value === `string` && value !== `` ? value : undefined);
const countOf = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

// Which semver step separates two versions. Compared as leading integers rather than by a semver library: the
// only question is which position first differs, and prerelease/build metadata cannot change that answer.
const versionParts = (version: string): number[] => version.replace(/^[^\d]*/, ``).split(`.`).map((part) => Number.parseInt(part, 10) || 0);

const semverKind = (current: string, latest: string): OutdatedPackage["kind"] => {
    const [currentMajor = 0, currentMinor = 0] = versionParts(current);
    const [latestMajor = 0, latestMinor = 0] = versionParts(latest);
    if (latestMajor !== currentMajor) {
        return `major`;
    }
    return latestMinor !== currentMinor ? `minor` : `patch`;
};

/* `pnpm outdated --json` prints a map of package name → { current, latest, dependencyType }. In a workspace the
 * recursive form merges every package's entries into the same map and adds `dependentPackages`, which is why this
 * reads the map rather than expecting a list: one shape covers both, and a field we don't use appearing is not a
 * parse failure. Entries missing `current` or `latest` are skipped — that is how pnpm reports a package it could
 * not resolve against the registry, and it is not evidence of anything. */
const parseOutdated = (stdout: string): ProbeFacts | undefined => {
    const root = asObject(stdout);
    if (root === undefined) {
        return undefined;
    }
    const packages: OutdatedPackage[] = [];
    for (const [name, raw] of Object.entries(root)) {
        if (typeof raw !== `object` || raw === null) {
            continue;
        }
        const entry = raw as Record<string, unknown>;
        const current = asString(entry[`current`]);
        const latest = asString(entry[`latest`]);
        if (current === undefined || latest === undefined || current === latest) {
            continue;
        }
        packages.push({ name, current, latest, kind: semverKind(current, latest), section: asString(entry[`dependencyType`]) ?? `dependencies` });
    }
    return { id: `outdated`, packages };
};

const SEVERITIES = new Set([`critical`, `high`, `moderate`, `low`, `info`]);

/* `pnpm audit --json` prints `{ advisories: { <id>: {...} }, metadata: {...} }`. The metadata's counts are
 * deliberately ignored: they are a tally, and this surface needs the advisories themselves — which package, and
 * whether a patched range exists — because "there is a fix that is a version bump" and "there is no patch yet"
 * lead to completely different turns, and a count cannot tell them apart.
 *
 * `dev` comes off the findings' own flag rather than being inferred. A build-time-only advisory is real but it is
 * not the same risk as one in a running service, and the chore's prompt says so instead of treating them alike. */
const parseAudit = (stdout: string): ProbeFacts | undefined => {
    const root = asObject(stdout);
    if (root === undefined) {
        return undefined;
    }
    const raw = root[`advisories`];
    // No `advisories` key at all is pnpm's clean report — an empty list, not an unrecognisable one.
    if (raw === undefined) {
        return { id: `audit`, advisories: [] };
    }
    if (typeof raw !== `object` || raw === null) {
        return undefined;
    }
    const advisories: Advisory[] = [];
    for (const value of Object.values(raw as Record<string, unknown>)) {
        if (typeof value !== `object` || value === null) {
            continue;
        }
        const entry = value as Record<string, unknown>;
        const name = asString(entry[`module_name`]);
        const severity = asString(entry[`severity`]);
        if (name === undefined || severity === undefined || !SEVERITIES.has(severity)) {
            continue;
        }
        const patched = asString(entry[`patched_versions`]);
        const findings = Array.isArray(entry[`findings`]) ? (entry[`findings`] as Record<string, unknown>[]) : [];
        advisories.push({
            name,
            severity: severity as Advisory["severity"],
            title: asString(entry[`title`]) ?? name,
            // "<0.0.0" is npm's spelling of "no patch exists", and treating it as a fixing range would have the
            // chore promise a bump that cannot be made.
            ...(patched === undefined || patched === `<0.0.0` ? {} : { patched }),
            dev: findings.length > 0 && findings.every((finding) => finding[`dev`] === true),
        });
    }
    return { id: `audit`, advisories };
};

/* knip's JSON reporter prints `{ files: [...], issues: [...] }` — `files` are wholly unreferenced, and each issue
 * entry carries per-kind arrays for one file. Counts plus a sample of the file paths, not the full list: the
 * agent re-runs knip itself against the live tree (a list from a probe hours old would send it at files that are
 * already gone), so what travels here only has to be enough to decide whether the turn is worth starting. */
const DEAD_CODE_SAMPLE = 8;

const parseKnip = (stdout: string): ProbeFacts | undefined => {
    const root = asObject(stdout);
    if (root === undefined || !Array.isArray(root[`files`])) {
        return undefined;
    }
    const issues = Array.isArray(root[`issues`]) ? (root[`issues`] as Record<string, unknown>[]) : [];
    const sum = (key: string): number => issues.reduce((total, issue) => total + countOf(issue[key]), 0);
    const deadCode: DeadCode = {
        files: root[`files`].length,
        exports: sum(`exports`),
        types: sum(`types`),
        dependencies: sum(`dependencies`),
        devDependencies: sum(`devDependencies`),
        sample: (root[`files`] as unknown[]).filter((file): file is string => typeof file === `string`).slice(0, DEAD_CODE_SAMPLE),
    };
    return { id: `knip`, deadCode };
};

/* jscpd writes its JSON to a file rather than stdout, which is why the command below ends in a `cat`. The report
 * carries `statistics[`total`].percentage` (of scanned lines) and a `duplicates` array; the percentage is what a
 * threshold is worth setting against, because a clone COUNT grows with the repository and would mean something
 * different every quarter. */
const DUPLICATION_SAMPLE = 5;

const parseJscpd = (stdout: string): ProbeFacts | undefined => {
    const root = asObject(stdout);
    const statistics = root?.[`statistics`];
    if (typeof statistics !== `object` || statistics === null) {
        return undefined;
    }
    const total = (statistics as Record<string, unknown>)[`total`];
    const percentage = typeof total === `object` && total !== null ? (total as Record<string, unknown>)[`percentage`] : undefined;
    const duplicates = Array.isArray(root?.[`duplicates`]) ? (root[`duplicates`] as Record<string, unknown>[]) : [];
    const pathOf = (side: unknown): string => (typeof side === `object` && side !== null ? (asString((side as Record<string, unknown>)[`name`]) ?? `?`) : `?`);
    const duplication: Duplication = {
        percentage: typeof percentage === `number` ? percentage : 0,
        clones: duplicates.length,
        top: duplicates
            .map((clone) => ({ lines: typeof clone[`lines`] === `number` ? clone[`lines`] : 0, first: pathOf(clone[`firstFile`]), second: pathOf(clone[`secondFile`]) }))
            .toSorted((left, right) => right.lines - left.lines)
            .slice(0, DUPLICATION_SAMPLE),
    };
    return { id: `jscpd`, duplication };
};

// Where the tier-2 tools leave their reports. Under /tmp because they are inputs to a parse that happens
// immediately after, never something to keep — the cached ProbeResult is the artefact that survives. The same
// path the scheduled form of this chore uses (chores.ts), so a workspace running both keeps one copy.
const JSCPD_DIR = `/tmp/intentic-chore-jscpd`;

export const PROBES: readonly ProbeSpec[] = [
    {
        id: `outdated`,
        title: `Dependency versions`,
        measures: `how far behind the registry each dependency is`,
        tier: 1,
        ttlMs: DAY_MS,
        timeoutMs: 5 * 60_000,
        available: `test -f package.json`,
        // `-r` so a monorepo reports every workspace package, not just the root's own handful. `|| true` because
        // pnpm exits non-zero exactly when it HAS findings, and the runner judges by whether the parse succeeded.
        command: `pnpm outdated -r --json 2>/dev/null || true`,
        parse: parseOutdated,
    },
    {
        id: `audit`,
        title: `Security advisories`,
        measures: `published advisories against this dependency tree`,
        tier: 1,
        ttlMs: DAY_MS,
        timeoutMs: 5 * 60_000,
        // A lockfile, not a package.json: auditing resolves the actual installed tree, and without one pnpm
        // reports against nothing.
        available: `test -f pnpm-lock.yaml || test -f package-lock.json`,
        command: `pnpm audit --json 2>/dev/null || true`,
        parse: parseAudit,
    },
    {
        id: `knip`,
        title: `Unreachable code`,
        measures: `files, exports and dependencies nothing references`,
        tier: 2,
        ttlMs: 7 * DAY_MS,
        timeoutMs: 15 * 60_000,
        // The repo's OWN knip, never a floating one: `pnpm dlx knip` would download a version that disagrees with
        // the repo's knip.json about what counts as an entry point, and then report its whole public API as dead.
        available: `pnpm exec knip --version >/dev/null 2>&1`,
        command: `pnpm exec knip --reporter json --no-exit-code 2>/dev/null || true`,
        parse: parseKnip,
    },
    {
        id: `jscpd`,
        title: `Copy-paste`,
        measures: `how much of the tree is duplicated elsewhere in it`,
        tier: 2,
        ttlMs: 7 * DAY_MS,
        timeoutMs: 20 * 60_000,
        available: `test -f package.json`,
        // `--threshold 100` so jscpd never fails the command on its own opinion of what is too much duplication —
        // that judgement is the chore's, made from the percentage, not the tool's exit code.
        command:
            `pnpm dlx jscpd --reporters json --output ${JSCPD_DIR} --min-lines 12 --threshold 100 . >/dev/null 2>&1; ` +
            `cat ${JSCPD_DIR}/jscpd-report.json 2>/dev/null`,
        parse: parseJscpd,
    },
];

export const probeSpec = (id: ProbeId): ProbeSpec => {
    const spec = PROBES.find((probe) => probe.id === id);
    if (spec === undefined) {
        throw new Error(`chores: no probe named "${id}"`);
    }
    return spec;
};
