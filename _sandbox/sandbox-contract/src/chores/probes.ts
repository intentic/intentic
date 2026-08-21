import type { Advisory, Bundle, DeadCode, Duplication, OutdatedPackage, ProbeFacts, ProbeId, UiScan } from "../schemas.js";
import type { IdiomRule } from "./stack.js";
import {
    BYPASS_PATTERN,
    COMPONENT_GLOBS,
    IDIOM_RULES,
    MARKUP_GLOBS,
    normalizePath,
    SCAN_IGNORES,
    UI_FRAMEWORKS,
    TAILWIND_PACKAGES,
} from "./stack.js";

/* THE PROBES, the measurements that cost a subprocess, declared once so the daemon that runs them and the panel
 * that explains them cannot disagree about what "outdated" meant.
 *
 * A spec is a shell command and a parser, deliberately in that order of trust: the command is whatever the tool's
 * own maintainers publish as its machine-readable output, and the parser is written to be DISAPPOINTED. Every one
 * of these tools has changed its JSON shape at least once, they are run against whatever version the repo pinned,
 * and a probe that throws on an unexpected field would take the whole maintenance surface down with it. So each
 * parser walks the structure defensively and returns `undefined` when it cannot recognise what it got, which the
 * runner records as a failed probe with the output attached, rather than as a clean repository.
 *
 * TIERS ARE ABOUT COST, and the cost is what sets the cadence. Tier 1 reads metadata that already exists (a
 * lockfile, a registry's version list) and finishes in seconds, so the background runner refreshes it daily. Tier
 * 2 reads the whole tree, knip type-checks it, jscpd tokenizes every file, and can run for minutes on a large
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
    /* What is MISSING when `available` says no, named here rather than derived from the title. The obvious
     * derivation, "this repository has no security advisories to measure", states the one thing an unmeasured
     * probe must never claim, that there are none, and it is the same conflation the block above exists to
     * prevent. Phrased as a bare clause ("no lockfile"), because the panel groups these under its own lead-in. */
    readonly unavailable: string;
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
const versionParts = (version: string): number[] =>
    version
        .replace(/^[^\d]*/, ``)
        .split(`.`)
        .map((part) => Number.parseInt(part, 10) || 0);

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
 * parse failure. Entries missing `current` or `latest` are skipped, that is how pnpm reports a package it could
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
 * deliberately ignored: they are a tally, and this surface needs the advisories themselves, which package, and
 * whether a patched range exists, because "there is a fix that is a version bump" and "there is no patch yet"
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
    // No `advisories` key at all is pnpm's clean report, an empty list, not an unrecognisable one.
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

/* knip's JSON reporter prints `{ issues: [...] }`, one row per file that has findings, carrying a per-kind array
 * of what it found there. A wholly unreferenced file is a row whose own `files` array names it, which is why that
 * count is a sum like every other kind rather than a list of its own. Counts plus a sample of the file paths, not
 * the full list: the agent re-runs knip itself against the live tree (a list from a probe hours old would send it
 * at files that are already gone), so what travels here only has to be enough to decide whether the turn is worth
 * starting. */
const DEAD_CODE_SAMPLE = 8;

const parseKnip = (stdout: string): ProbeFacts | undefined => {
    const raw = asObject(stdout)?.[`issues`];
    // `issues` is the whole report in this reporter, so its absence means we are not reading knip's output at all.
    if (!Array.isArray(raw)) {
        return undefined;
    }
    const issues = raw.filter((issue): issue is Record<string, unknown> => typeof issue === `object` && issue !== null);
    const sum = (key: string): number => issues.reduce((total, issue) => total + countOf(issue[key]), 0);
    const deadCode: DeadCode = {
        files: sum(`files`),
        exports: sum(`exports`),
        types: sum(`types`),
        dependencies: sum(`dependencies`),
        devDependencies: sum(`devDependencies`),
        sample: issues.flatMap((issue) => (countOf(issue[`files`]) === 0 ? [] : (asString(issue[`file`]) ?? []))).slice(0, DEAD_CODE_SAMPLE),
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
    const pathOf = (side: unknown): string =>
        typeof side === `object` && side !== null ? (asString((side as Record<string, unknown>)[`name`]) ?? `?`) : `?`;
    const duplication: Duplication = {
        percentage: typeof percentage === `number` ? percentage : 0,
        clones: duplicates.length,
        top: duplicates
            .map((clone) => ({
                lines: typeof clone[`lines`] === `number` ? clone[`lines`] : 0,
                first: pathOf(clone[`firstFile`]),
                second: pathOf(clone[`secondFile`]),
            }))
            .toSorted((left, right) => right.lines - left.lines)
            .slice(0, DUPLICATION_SAMPLE),
    };
    return { id: `jscpd`, duplication };
};

/* THE UI SWEEP. The only probe here whose command is COMPOSED rather than written out, because its subject is a
 * table (stack.ts) that will grow and a hand-written command would be a second copy of it going stale.
 *
 * Everything it emits is a labelled, tab-separated line, and the first line is always the bare marker `UI`. That
 * marker is the whole reason this parser can tell "the sweep ran and this repository is clean" from "the sweep
 * never ran": every other line is optional, so without it an empty stdout and a spotless codebase are the same
 * string, and reporting the second when it was the first is the one thing probes.ts exists to prevent. */
const UI_MARKER = `UI`;
// Caps, applied after `sort` so truncation is alphabetical and therefore identical between runs, an unsorted
// truncation would mint a new digest on every sweep and badge forever. What is dropped is genuinely dropped: a
// component past the cap cannot join a family, and the chore says so rather than implying it saw everything.
const COMPONENT_LIMIT = 2000;
const RULE_FILE_LIMIT = 500;

/* THE `.` IS LOAD-BEARING, and leaving it off cost this probe every finding it will ever have. Given no path,
 * ripgrep searches the tree only when stdin is a TTY, otherwise it reads STDIN, which is exactly how the runner
 * spawns a probe. The sweep therefore ran, exited 0, printed its marker and matched nothing, in every repository,
 * forever: the precise failure the marker line was introduced to make impossible, arriving through the one door it
 * does not cover. It reproduces from Node and not from an interactive shell, which is why it survived being read.
 *
 * The prefix that comes back with it (`./src/Button.vue`) is normalised away at the parse, so one spelling of a
 * path reaches the chores no matter which tool produced it. */
const SCAN_ROOT = `.`;

const globArgs = (globs: readonly string[]): string => [...globs, ...SCAN_IGNORES].map((glob) => `-g '${glob}'`).join(` `);

// `path:count` from `rg --count-matches`, normalised. Split at the LAST colon: a path may contain one, a count is
// always the digits at the end.
const splitCount = (text: string): { path: string; count: number } | undefined => {
    const at = text.lastIndexOf(`:`);
    if (at <= 0) {
        return undefined;
    }
    const count = Number.parseInt(text.slice(at + 1), 10);
    return Number.isNaN(count) || count <= 0 ? undefined : { path: normalizePath(text.slice(0, at)), count };
};

/* An idiom's line is a PATH AND NOTHING ELSE, which is what lets one line shape carry both kinds of rule. A
 * present rule asks ripgrep which files match (`-l`); an absent one asks which files do not (`--files-without-
 * match`), and neither has a count to report. Nothing downstream ever wanted one: a file is on the old idiom or
 * it is not, and how many times it says so within itself is not a fact anyone would act on differently. */
const idiomCommand = (rule: IdiomRule): string =>
    `rg --no-messages ${rule.absent === undefined ? `-l` : `--files-without-match`} -e '${rule.pattern}' ${globArgs(rule.globs)} ${SCAN_ROOT} 2>/dev/null ` +
    `| sort | head -n ${RULE_FILE_LIMIT} | awk '{print "IDIOM\\t${rule.id}\\t" $0}'`;

const scanCommand = (): string =>
    [
        `echo ${UI_MARKER}`,
        `rg --files ${globArgs(COMPONENT_GLOBS)} ${SCAN_ROOT} 2>/dev/null | sort | head -n ${COMPONENT_LIMIT} | awk '{print "COMPONENT\\t" $0}'`,
        `rg --no-messages --count-matches -e '${BYPASS_PATTERN}' ${globArgs(MARKUP_GLOBS)} ${SCAN_ROOT} 2>/dev/null ` +
            `| sort | head -n ${RULE_FILE_LIMIT} | awk '{print "BYPASS\\t" $0}'`,
        ...IDIOM_RULES.map(idiomCommand),
        // Every rg above exits 1 when it matches nothing, which is the healthy case and must not read as a broken
        // command. The runner judges by the parse, but leaving the script's own status at 1 would be a lie.
        `true`,
    ].join(`; `);

const parseUi = (stdout: string): ProbeFacts | undefined => {
    const lines = stdout.split(`\n`).map((line) => line.trim());
    if (lines.find((line) => line !== ``) !== UI_MARKER) {
        return undefined;
    }
    const components: string[] = [];
    const bypasses: UiScan["bypasses"] = [];
    const byIdiom = new Map<string, string[]>();
    for (const line of lines) {
        const [label, ...rest] = line.split(`\t`);
        if (label === `COMPONENT` && rest[0] !== undefined) {
            components.push(normalizePath(rest[0]));
        } else if (label === `BYPASS`) {
            const hit = splitCount(rest.join(`\t`));
            if (hit !== undefined) {
                bypasses.push(hit);
            }
        } else if (label === `IDIOM` && rest[0] !== undefined) {
            const path = normalizePath(rest.slice(1).join(`\t`));
            if (path !== ``) {
                byIdiom.set(rest[0], [...(byIdiom.get(rest[0]) ?? []), path]);
            }
        }
    }
    const scan: UiScan = { components, bypasses, idioms: [...byIdiom].map(([id, files]) => ({ id, files })) };
    return { id: `ui`, scan };
};

/* THE BUILD OUTPUT, measured where it already is. See BundleSchema for why this never runs the build; the
 * consequence here is that `available` is a question about the filesystem rather than about the toolchain, and a
 * repository whose only builds happen in CI reports `unavailable` rather than a wrong number. */
const BUILD_DIRS = [`dist`, `build`, `out`, `public/build`];
const BUNDLE_MARKER = `DIR`;
// Enough of the ranking to see the shape of a build. Past this the assets are the long tail of lazy chunks, and
// carrying four hundred of them on a route the rail badge polls would cost more than the finding is worth.
const ASSET_LIMIT = 40;

const bundleCommand = (): string =>
    [
        `dir=""`,
        `for d in ${BUILD_DIRS.join(` `)}; do if [ -d "$d" ]; then dir="$d"; break; fi; done`,
        `[ -n "$dir" ] || exit 0`,
        `printf '${BUNDLE_MARKER}\\t%s\\n' "$dir"`,
        // `-exec ... {} +` rather than a `for` over command substitution: a hashed asset name will not contain a
        // space, but a build that copies user content into the output can, and a probe is not the place to find
        // out. Sorted by raw bytes so the head is the ranking rather than whatever order the walk returned.
        `find "$dir" -type f \\( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.css' \\) ` +
            `-exec sh -c 'for f; do printf "ASSET\\t%s\\t%s\\t%s\\n" "$(wc -c <"$f")" "$(gzip -c "$f" | wc -c)" "$f"; done' _ {} + ` +
            `2>/dev/null | sort -k2 -rn | head -n ${ASSET_LIMIT}`,
    ].join(`; `);

const parseBundle = (stdout: string): ProbeFacts | undefined => {
    const lines = stdout.split(`\n`).map((line) => line.trim());
    const dirLine = lines.find((line) => line.startsWith(`${BUNDLE_MARKER}\t`));
    if (dirLine === undefined) {
        return undefined;
    }
    const assets: Bundle["assets"] = [];
    for (const line of lines) {
        const [label, rawBytes, rawGzip, ...path] = line.split(`\t`);
        if (label !== `ASSET` || path.length === 0) {
            continue;
        }
        const bytes = Number.parseInt(rawBytes ?? ``, 10);
        const gzip = Number.parseInt(rawGzip ?? ``, 10);
        if (Number.isNaN(bytes) || Number.isNaN(gzip)) {
            continue;
        }
        assets.push({ path: path.join(`\t`), bytes, gzip });
    }
    const bundle: Bundle = {
        dir: dirLine.slice(BUNDLE_MARKER.length + 1),
        // Of the assets CARRIED, which is the top of the ranking rather than the whole build. The chore says so
        // when it quotes the number: a total that silently excluded the tail would be the more misleading of the
        // two, and re-walking the tree to sum it would double the probe's cost for a figure nobody splits on.
        totalBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
        totalGzip: assets.reduce((sum, asset) => sum + asset.gzip, 0),
        assets,
    };
    return { id: `bundle`, bundle };
};

// Where the tier-2 tools leave their reports. Under /tmp because they are inputs to a parse that happens
// immediately after, never something to keep, the cached ProbeResult is the artefact that survives. The same
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
        unavailable: `no package.json`,
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
        unavailable: `no lockfile`,
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
        unavailable: `knip is not a devDependency`,
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
        unavailable: `no package.json`,
        // `--threshold 100` so jscpd never fails the command on its own opinion of what is too much duplication,
        // that judgement is the chore's, made from the percentage, not the tool's exit code.
        command:
            `pnpm dlx jscpd --reporters json --output ${JSCPD_DIR} --min-lines 12 --threshold 100 . >/dev/null 2>&1; ` +
            `cat ${JSCPD_DIR}/jscpd-report.json 2>/dev/null`,
        parse: parseJscpd,
    },
    {
        id: `ui`,
        title: `Front-end source`,
        measures: `components, hard-coded styles and idioms the framework has replaced`,
        /* Tier 1 despite reading the whole tree, and the placement is a judgement rather than an oversight. The
         * tier is about COST: this is a dozen ripgrep walks, seconds on a large monorepo, against knip
         * type-checking the tree and jscpd tokenizing every file for minutes. A weekly TTL would also make it the
         * wrong shape, its findings move whenever someone writes a component, which is daily. */
        tier: 1,
        ttlMs: DAY_MS,
        timeoutMs: 5 * 60_000,
        // Any manifest in the repo declaring a UI framework or Tailwind, not just the root's, a monorepo keeps
        // React in the app package and the root manifest is a handful of build tools.
        available:
            `rg -l --no-messages -g '**/package.json' -g '!**/node_modules/**' ` +
            `-e '[\\x22](${[...UI_FRAMEWORKS.flatMap((framework) => framework.packages), ...TAILWIND_PACKAGES].join(`|`)})[\\x22]\\s*:' . >/dev/null`,
        unavailable: `no package here declares a UI framework or Tailwind`,
        command: scanCommand(),
        parse: parseUi,
    },
    {
        id: `bundle`,
        title: `Build output`,
        measures: `what the last build put on disk for a browser to download`,
        tier: 1,
        ttlMs: DAY_MS,
        timeoutMs: 5 * 60_000,
        // A build directory that actually contains something a browser would download. `-d` alone would pass on
        // the empty `dist/` a cleaned checkout leaves behind, and the measurement would report a zero-byte bundle
        // as a fact about the application.
        available: `find ${BUILD_DIRS.join(` `)} -maxdepth 4 -type f \\( -name '*.js' -o -name '*.mjs' -o -name '*.css' \\) 2>/dev/null | head -n 1 | grep -q .`,
        // Says what is missing AND that this never builds, because the obvious reading of "no build output" is
        // that we tried and it failed. The owner running their own build once is the whole fix.
        unavailable: `no build output on disk, this reads the last build, it never runs one`,
        command: bundleCommand(),
        parse: parseBundle,
    },
];

export const probeSpec = (id: ProbeId): ProbeSpec => {
    const spec = PROBES.find((probe) => probe.id === id);
    if (spec === undefined) {
        throw new Error(`chores: no probe named "${id}"`);
    }
    return spec;
};
