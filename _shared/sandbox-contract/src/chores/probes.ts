import type { Advisory, Bundle, DeadCode, Duplication, MutationScore, OutdatedPackage, ProbeFacts, ProbeId, UiScan } from "../schemas/maintenance.js";
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
import { WORKSPACE_ROOT_JSCPD_EXCLUDE_ARG, WORKSPACE_ROOT_RG_EXCLUDE_ARG } from "./workspace-scope.js";

// Probe specs (command + parser) shared by the daemon and the panel so both agree on what each measurement means.
// Parsers return `undefined` rather than throw on an unrecognized shape, since a tool's JSON output can drift between
// versions; the runner records that as a failed probe, not a clean repo.
// Tier sets refresh cadence by cost (tier 1 daily, tier 2 weekly); a non-zero `available` means unmeasured, never a
// false-clean result.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface ProbeSpec {
    readonly id: ProbeId;
    readonly title: string;
    // Shown to the reader in the panel, next to the probe's age.
    readonly measures: string;
    readonly tier: 1 | 2;
    // How long a result stays fresh; the background runner refreshes past it, manual refresh ignores it.
    readonly ttlMs: number;
    readonly timeoutMs: number;
    // Exit 0 means this repo can be measured; runs in the repo's own directory, like `command`.
    readonly available: string;
    // What's missing, as a bare clause; must never imply the repo has zero findings (unmeasured is not clean).
    readonly unavailable: string;
    // Runs via `sh -c` in the repo dir; non-zero exit isn't failure, the runner judges by whether parse succeeded.
    readonly command: string;
    readonly parse: (stdout: string) => ProbeFacts | undefined;
}

// Parses the first `{...}` found as JSON, or returns undefined; tolerates leading warnings or empty stdout without
// throwing.
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

// Leading-integer parts of a version, compared positionally rather than via full semver; prerelease/build metadata
// can't change which position differs first.
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

// `pnpm outdated --json` prints a name→{current,latest,dependencyType} map; the recursive workspace form merges into
// the same shape.
// Entries missing `current` or `latest` are skipped: pnpm could not resolve them against the registry.
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

// `pnpm audit --json` prints {advisories, metadata}; metadata's tally is ignored since the chore needs which package
// and whether a patch exists.
// `dev` is read from the findings' own flag: a build-time-only advisory is a different risk than one in a running
// service.
const parseAudit = (stdout: string): ProbeFacts | undefined => {
    const root = asObject(stdout);
    if (root === undefined) {
        return undefined;
    }
    const raw = root[`advisories`];
    // No `advisories` key is pnpm's clean report (empty list), not an unrecognized shape.
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
            // `<0.0.0` is npm's spelling of "no patch exists"; treated as absent rather than a fixable range.
            ...(patched === undefined || patched === `<0.0.0` ? {} : { patched }),
            dev: findings.length > 0 && findings.every((finding) => finding[`dev`] === true),
        });
    }
    return { id: `audit`, advisories };
};

// Sample of paths only; the agent re-runs knip live, so a full list would already be stale.
const DEAD_CODE_SAMPLE = 8;

const parseKnip = (stdout: string): ProbeFacts | undefined => {
    const raw = asObject(stdout)?.[`issues`];
    // `issues` is the whole report; its absence means this isn't knip's output at all.
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

// jscpd writes JSON to a file, not stdout; percentage of scanned lines is stable, unlike a raw clone count.
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

// Timeout counts as DETECTED, NoCoverage as UNDETECTED; Pending is inconclusive, not dropped either way.
const SURVIVOR_SAMPLE = 8;
const DETECTED = new Set([`Killed`, `Timeout`]);
const UNDETECTED = new Set([`Survived`, `NoCoverage`]);

type Survivor = MutationScore["survivors"][number];

// One file's mutant list, or empty for any shape that doesn't match; a malformed entry doesn't invalidate the rest of
// the report.
const mutantsOf = (raw: unknown): readonly Record<string, unknown>[] => {
    if (typeof raw !== `object` || raw === null) {
        return [];
    }
    const mutants = (raw as Record<string, unknown>)[`mutants`];
    return Array.isArray(mutants) ? mutants.filter((entry): entry is Record<string, unknown> => typeof entry === `object` && entry !== null) : [];
};

const lineOf = (mutant: Record<string, unknown>): number => {
    const location = mutant[`location`];
    const start = typeof location === `object` && location !== null ? (location as Record<string, unknown>)[`start`] : undefined;
    const line = typeof start === `object` && start !== null ? (start as Record<string, unknown>)[`line`] : undefined;
    return typeof line === `number` ? line : 0;
};

const survivorOf = (file: string, mutant: Record<string, unknown>): Survivor => ({
    file,
    line: lineOf(mutant),
    mutator: asString(mutant[`mutatorName`]) ?? `?`,
    // Empty replacement means the mutator deleted the expression; rendered as `(removed)` rather than blank.
    replacement: asString(mutant[`replacement`]) ?? `(removed)`,
});

interface Tally {
    killed: number;
    survived: number;
    inconclusive: number;
    readonly survivors: Survivor[];
}

const tallyMutants = (files: Record<string, unknown>): Tally => {
    const tally: Tally = { killed: 0, survived: 0, inconclusive: 0, survivors: [] };
    for (const [file, raw] of Object.entries(files)) {
        for (const mutant of mutantsOf(raw)) {
            const status = asString(mutant[`status`]) ?? ``;
            if (DETECTED.has(status)) {
                tally.killed++;
                continue;
            }
            // Neither detected nor undetected got a verdict; it didn't compile or was ignored, and doesn't move the
            // score.
            if (!UNDETECTED.has(status)) {
                tally.inconclusive++;
                continue;
            }
            tally.survived++;
            tally.survivors.push(survivorOf(file, mutant));
        }
    }
    return tally;
};

const parseMutation = (stdout: string): ProbeFacts | undefined => {
    const files = asObject(stdout)?.[`files`];
    // Missing `files` means this isn't a mutation report; an empty one is honest (nothing was mutated).
    if (typeof files !== `object` || files === null || Array.isArray(files)) {
        return undefined;
    }
    const tally = tallyMutants(files as Record<string, unknown>);
    const valid = tally.killed + tally.survived;
    const mutation: MutationScore = {
        // Nothing to mutate scores 100, not NaN: no undetected fault exists, and it avoids dividing by zero.
        score: valid === 0 ? 100 : Math.round((tally.killed / valid) * 100),
        killed: tally.killed,
        survived: tally.survived,
        inconclusive: tally.inconclusive,
        survivors: tally.survivors.slice(0, SURVIVOR_SAMPLE),
    };
    return { id: `mutation`, mutation };
};

// First output line is always literal marker `UI`: distinguishes a clean sweep from one that never ran.
const UI_MARKER = `UI`;
// Caps apply after `sort`: truncation is alphabetical and stable between runs; anything past the cap is dropped.
const COMPONENT_LIMIT = 2000;
const RULE_FILE_LIMIT = 500;

// Required: without a path, ripgrep reads stdin instead of the tree when run non-interactively, as here.
const SCAN_ROOT = `.`;

const globArgs = (globs: readonly string[]): string =>
    [...[...globs, ...SCAN_IGNORES].map((glob) => `-g '${glob}'`), WORKSPACE_ROOT_RG_EXCLUDE_ARG].join(` `);

// `path:count` from `rg --count-matches`; splits at the last colon since a path may contain one but the count is always
// trailing digits.
const splitCount = (text: string): { path: string; count: number } | undefined => {
    const at = text.lastIndexOf(`:`);
    if (at <= 0) {
        return undefined;
    }
    const count = Number.parseInt(text.slice(at + 1), 10);
    return Number.isNaN(count) || count <= 0 ? undefined : { path: normalizePath(text.slice(0, at)), count };
};

// Emits a bare path per match: `-l` for a present rule, `--files-without-match` for an absent one; no count is ever
// needed downstream.
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
        // Resets exit status to 0: an rg above exiting 1 (no matches) is the healthy case, not a broken command.
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

// Checks disk, not the toolchain: a CI-only build reports unavailable, not a wrong number.
const BUILD_DIRS = [`dist`, `build`, `out`, `public/build`];
const BUNDLE_MARKER = `DIR`;
// Ranking cutoff; past this are long-tail lazy chunks not worth the badge route's cost to carry.
const ASSET_LIMIT = 40;

const bundleCommand = (): string =>
    [
        `dir=""`,
        `for d in ${BUILD_DIRS.join(` `)}; do if [ -d "$d" ]; then dir="$d"; break; fi; done`,
        `[ -n "$dir" ] || exit 0`,
        `printf '${BUNDLE_MARKER}\\t%s\\n' "$dir"`,
        // `-exec ... {} +`, not a `for` loop: an asset path can contain a space; sorted by bytes so head is the
        // ranking.
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
        // Sum of the assets carried (the ranking), not the whole build; avoids a second walk to total the rest.
        totalBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
        totalGzip: assets.reduce((sum, asset) => sum + asset.gzip, 0),
        assets,
    };
    return { id: `bundle`, bundle };
};

// jscpd report dir under /tmp, read immediately then discarded; same path chores.ts uses.
const JSCPD_DIR = `/tmp/intentic-chore-jscpd`;
// Stryker's own default json-report path, not configurable per run; read from the repo dir the probe runs in.
const MUTATION_REPORT = `reports/mutation/mutation.json`;

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
        // `-r` reports every workspace package, not just root; `|| true` since pnpm exits non-zero when it has
        // findings.
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
        // A lockfile, not package.json: audit resolves the installed tree, and without one pnpm has nothing to check.
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
        // The repo's own knip, never a floating one: a mismatched version can call its own live API dead code.
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
        // `--threshold 100` stops jscpd failing on its own opinion; the chore judges duplication from the percentage.
        command:
            `pnpm dlx jscpd ${WORKSPACE_ROOT_JSCPD_EXCLUDE_ARG} --reporters json --output ${JSCPD_DIR} --min-lines 12 --threshold 100 . >/dev/null 2>&1; ` +
            `cat ${JSCPD_DIR}/jscpd-report.json 2>/dev/null`,
        parse: parseJscpd,
    },
    {
        id: `mutation`,
        title: `Test strength`,
        measures: `how much of the code could break with every test still green`,
        // `--incremental` reruns only changed mutants; the 30-day TTL targets that costly first full run.
        tier: 2,
        ttlMs: 30 * DAY_MS,
        timeoutMs: 90 * 60_000,
        // Config presence means the repo opted in, not just having Stryker; must use the repo's own stryker, not `dlx`.
        available: `{ test -f stryker.conf.mjs || test -f stryker.conf.json; } && pnpm exec stryker --version >/dev/null 2>&1`,
        unavailable: `no stryker config in this repo`,
        // `|| true`: Stryker exits non-zero under its own score threshold; the parser decides if the run was valid.
        command: `pnpm exec stryker run --reporters json --incremental >/dev/null 2>&1 || true; cat ${MUTATION_REPORT} 2>/dev/null`,
        parse: parseMutation,
    },
    {
        id: `ui`,
        title: `Front-end source`,
        measures: `components, hard-coded styles and idioms the framework has replaced`,
        // Tier 1 despite scanning the tree: ripgrep walks cost seconds, and findings move daily as components change.
        tier: 1,
        ttlMs: DAY_MS,
        timeoutMs: 5 * 60_000,
        // Any manifest declaring a framework or Tailwind, not just root's; monorepos often keep React in an app
        // package.
        available:
            `rg -l --no-messages -g '**/package.json' -g '!**/node_modules/**' ${WORKSPACE_ROOT_RG_EXCLUDE_ARG} ` +
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
        // Must contain an actual asset file: `-d` alone would pass an empty `dist/` left by a cleaned checkout.
        available: `find ${BUILD_DIRS.join(` `)} -maxdepth 4 -type f \\( -name '*.js' -o -name '*.mjs' -o -name '*.css' \\) 2>/dev/null | head -n 1 | grep -q .`,
        // States it never builds, only reads the last one: "no output" would otherwise read as "the build failed".
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
