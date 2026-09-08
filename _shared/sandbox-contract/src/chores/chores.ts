import type { Advisory, ChoreSignals, OutdatedPackage, ProbeId, ProbeResult } from "../schemas/maintenance.js";
import { bucketOf, digestOf } from "./digest.js";
import { CHORE_INVARIANTS, composeAsk, REPORT_INVARIANTS, TRIAGE_NOTE } from "./prompt.js";
import { componentStem, frameworksOf, idiomRule, normalizePath, UI_FRAMEWORKS, usesTailwind } from "./stack.js";
import { WORKSPACE_ROOT_JSCPD_EXCLUDE_ARG } from "./workspace-scope.js";

// Routine maintenance a repo is owed, surfaced only as events: a chore's `digest` is built from the identities of what
// changed, not a count, so ordinary drift never rebadges. Thresholds are leader-relative, not a per-repo tuned number.
// A chore goes quiet only because the measurement itself moved; nothing here is manually ticked off.

export type ChoreStance = "act" | "report";

// What kind of claim a chore makes on someone's attention, from an active risk to a periodic review; see CHORE_KINDS
// for the order and the words the panel groups under.
export type ChoreKind = "carrying" | "accruing" | "drifting" | "surveying";

export interface ChoreContext {
    // Root-relative repo dir; the empty string is the workspace's own root repo.
    readonly repo: string;
    readonly probes: ReadonlyMap<ProbeId, ProbeResult>;
    readonly signals: ChoreSignals;
    // What the daemon is actually RUNNING, not what a manifest wishes for.
    readonly node: string;
    readonly nowMs: number;
}

// What a chore found, when it found anything; `undefined` from `assess` is the healthy, common case.
export interface ChoreFinding {
    // One line, in numbers; the reader decides from this alone whether to open anything.
    readonly headline: string;
    // The evidence, one claim per line; what makes the headline checkable, not just believed.
    readonly detail: readonly string[];
    // The identity of this evidence; see digest.ts, it is what the rail's transitions are measured against.
    readonly digest: string;
    // `warning` is for a risk carried right now (a live advisory, an EOL runtime); everything else is `info`.
    readonly severity: "info" | "warning";
    // The numbers again, in the agent's terms, for the prompt's "Why:" line; exact, the agent may recount them.
    readonly why: string;
}

export interface Chore {
    readonly id: string;
    readonly title: string;
    // An app icon name, left as a plain string so this library doesn't depend on the UI kit to name a glyph.
    readonly icon: string;
    // The one-line standing description, shown whether or not the chore is currently due.
    readonly description: string;
    // A field, not a comment, so the book's reading order is compiler-checked, not hand-maintained.
    readonly kind: ChoreKind;
    // The threshold this chore is due by, stated as a criterion a reader can check and disagree with, not a topic.
    readonly criterion: string;
    // Whether the question makes sense here, distinct from `assess`; undefined means yes, else a bare cause spelled
    // identically to group by.
    readonly applies?: (signals: ChoreSignals) => string | undefined;
    // Whether the turn may change anything; not a hint, it selects the invariants block and is stated to the agent.
    readonly stance: ChoreStance;
    // Probes that must have run and succeeded first; missing means unavailable, shown greyed, never mistaken for clean.
    readonly needs: readonly ProbeId[];
    // How long until this is worth doing again regardless of what changed: a backstop for a measured chore, the whole
    // trigger for a survey.
    readonly cadenceMs: number;
    // Named rather than inferred from an empty `needs`: a survey has no measurement, and the panel says which kind of
    // row this is.
    readonly survey?: true;
    // Wakes on a clock, unattended, so it carries a guard (a shell one-liner, exits non-zero to skip) instead of a
    // finding.
    readonly automation?: {
        readonly cron: string;
        readonly guard: string;
        readonly note: string;
        readonly report: string;
        // How the woken turn is told what it is looking at, in place of a finding.
        readonly woke: string;
    };
    readonly assess: (context: ChoreContext) => ChoreFinding | undefined;
    // The prompt's three parts: `diagnosis` explains the numbers, `goal` is the shape to move toward (never a design),
    // `done` is agent-falsifiable.
    readonly diagnosis: string;
    readonly goal: string;
    readonly done: string;
}

const DAY_MS = 86_400_000;

// Where a scheduled chore's guard leaves its report; under /tmp since these feed a turn moments later, not kept.
const AUDIT_REPORT = `/tmp/intentic-chore-audit.json`;
const KNIP_REPORT = `/tmp/intentic-chore-knip.json`;
const JSCPD_DIR = `/tmp/intentic-chore-jscpd`;
const JSCPD_REPORT = `${JSCPD_DIR}/jscpd-report.json`;

// How a repo is named to a person or an agent; "root" (the wire id for the workspace's own repo) reads as a real
// directory name to an agent, so it is spelled out here once rather than at every call site.
export const repoLabel = (repo: string): string => (repo === `root` || repo === `` ? `the workspace root repository` : repo);

// The same repository, named for a narrow column or chip; `repoLabel`'s prose truncates badly there ("the
// workspace root reposi…").
export const repoName = (repo: string): string => (repo === `root` || repo === `` ? `workspace root` : repo);

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

// One outdated dependency, as the panel lists it; the semver step leads, since it decides whether the row is a
// morning's work or a project.
const outdatedLine = (entry: OutdatedPackage): string => `${entry.kind} · ${entry.name} ${entry.current} → ${entry.latest}`;

// The facts of a probe that actually ran; anything else (never run, unavailable, failed) reads as absent, so
// assess() can't mistake an unmeasured repo for a clean one.
const factsOf = <T extends ProbeId>(context: ChoreContext, id: T): Extract<NonNullable<ProbeResult["facts"]>, { id: T }> | undefined => {
    const probe = context.probes.get(id);
    if (probe?.state !== `ok` || probe.facts === undefined || probe.facts.id !== id) {
        return undefined;
    }
    return probe.facts as Extract<NonNullable<ProbeResult["facts"]>, { id: T }>;
};

// ---- the entries -----------------------------------------------------------------------------------------------

const BLOCKING = new Set<Advisory["severity"]>([`critical`, `high`]);

// Security is the only chore with no cadence: an advisory isn't something that becomes worth reading after 30
// days. Also the only one that reaches `warning` routinely, so the bar is critical-or-high with production/dev carried
// to the prompt.
const security: Chore = {
    id: `security-advisories`,
    title: `Patch security advisories`,
    icon: `shield`,
    description: `Published advisories against this dependency tree, and the ones whose fix is a version bump.`,
    kind: `carrying`,
    criterion: `pnpm audit reports an advisory of high or critical severity against the resolved tree.`,
    applies: (signals) => (signals.shape.lockfile ? undefined : `no lockfile`),
    stance: `act`,
    needs: [`audit`],
    cadenceMs: 0,
    automation: {
        cron: `0 4 * * *`,
        guard:
            `pnpm audit --json > ${AUDIT_REPORT} 2>/dev/null; ` +
            `[ "$(jq '(.metadata.vulnerabilities.high // 0) + (.metadata.vulnerabilities.critical // 0)' ${AUDIT_REPORT} 2>/dev/null || echo 0)" -gt 0 ]`,
        note: `nightly · high + critical only`,
        report: AUDIT_REPORT,
        woke: `pnpm audit's report for this workspace is in ${AUDIT_REPORT} (JSON), and it woke you because it carries a high or critical advisory.`,
    },
    assess: (context) => {
        const facts = factsOf(context, `audit`);
        if (facts === undefined) {
            return undefined;
        }
        const blocking = facts.advisories.filter((advisory) => BLOCKING.has(advisory.severity));
        if (blocking.length === 0) {
            return undefined;
        }
        const production = blocking.filter((advisory) => !advisory.dev);
        const patchable = blocking.filter((advisory) => advisory.patched !== undefined);
        return {
            headline: `${plural(blocking.length, `advisory`, `advisories`)}, ${patchable.length} with a published fix`,
            detail: blocking
                .toSorted((left, right) => left.name.localeCompare(right.name))
                .map(
                    (advisory) =>
                        `${advisory.severity} · ${advisory.name}, ${advisory.title}${advisory.patched === undefined ? ` (no patch yet)` : ``}`,
                ),
            // Identities, not counts: every advisory that appears or is fixed is genuinely news, with no ordinary drift
            // to absorb.
            digest: digestOf(...blocking.map((advisory) => `${advisory.name}@${advisory.severity}`).toSorted()),
            severity: production.length > 0 ? `warning` : `info`,
            // Named, not counted; re-deriving the list itself would be slow, and pnpm audit would read a different tree
            // by then.
            why:
                `pnpm audit reports ${plural(blocking.length, `high or critical advisory`, `high or critical advisories`)} against ` +
                `${repoLabel(context.repo)}, ${production.length} reaching a production dependency path, ${patchable.length} with a published patched range: ` +
                `${blocking.map((advisory) => `${advisory.name} (${advisory.severity}${advisory.dev ? `, dev-only` : ``}${advisory.patched === undefined ? `, no patch` : `, fixed in ${advisory.patched}`})`).join(`; `)}.`,
        };
    },
    diagnosis: `An advisory with a published fix is a version bump someone has to actually make; one without is a risk to decide about.`,
    goal:
        `For each advisory, establish whether this workspace reaches the vulnerable code path at all: a transitive dependency of a ` +
        `build-time tool is a different problem from one in a running service. Where the fix is a version bump the lockfile can absorb, ` +
        `make it. Where it needs a real upgrade or has no patch published, leave it and say what it would take. Never rewrite ` +
        `application code to route around a CVE.`,
    done: `Done when \`pnpm audit\` reports fewer high/critical advisories than it did, and the repository's type-check and tests pass.`,
};

// Majors are the finding, the total is context: the digest is keyed to which packages have a major waiting, with
// the count riding along bucketed so ordinary drift doesn't read as news.
const OUTDATED_NOISE_FLOOR = 20;

const dependencies: Chore = {
    id: `dependencies-outdated`,
    title: `Update dependencies`,
    icon: `arrow-circle-up`,
    description: `How far behind the registry this tree has drifted, and which majors are waiting.`,
    kind: `accruing`,
    criterion: `A dependency is a major version behind, or more than 20 are behind by any amount.`,
    applies: (signals) => (signals.shape.packageManifest ? undefined : `no package.json`),
    stance: `act`,
    needs: [`outdated`],
    cadenceMs: 30 * DAY_MS,
    assess: (context) => {
        const facts = factsOf(context, `outdated`);
        if (facts === undefined) {
            return undefined;
        }
        const majors = facts.packages.filter((entry) => entry.kind === `major`);
        // A healthy repo, not a chore: the floor is on the total, since minors and patches are only worth a turn in
        // bulk.
        if (majors.length === 0 && facts.packages.length < OUTDATED_NOISE_FLOOR) {
            return undefined;
        }
        return {
            headline:
                majors.length === 0
                    ? `${plural(facts.packages.length, `package`)} behind`
                    : `${plural(majors.length, `major`)} waiting, ${facts.packages.length} behind in total`,
            detail: majors.toSorted((left, right) => left.name.localeCompare(right.name)).map(outdatedLine),
            digest: digestOf(...majors.map((entry) => `${entry.name}@${entry.latest}`).toSorted(), `total:${bucketOf(facts.packages.length)}`),
            severity: `info`,
            // Majors are named since they are what the turn is about; minors and patches are a bulk operation the agent
            // enumerates itself.
            why:
                `pnpm outdated reports ${plural(facts.packages.length, `dependency`, `dependencies`)} behind the registry in ` +
                `${repoLabel(context.repo)}, ${majors.length} of them by a major version` +
                `${majors.length === 0 ? `` : `: ${majors.map((entry) => `${entry.name} ${entry.current} → ${entry.latest}`).join(`; `)}`}.`,
        };
    },
    diagnosis: `Version drift is cheap to fix continuously and expensive to fix in one go, because the majors start depending on each other.`,
    goal:
        `Take the patch and minor upgrades in one pass: those are what the lockfile can absorb without argument. Then take the majors ` +
        `ONE AT A TIME, reading each one's changelog for breaking changes before you touch anything, and stop at the first one that ` +
        `needs more than a mechanical fix: leave it, and say what it would take. Do not batch majors; a failing test after eight of them ` +
        `is a bisect nobody wanted.`,
    done: `Done when the repository's type-check and tests pass, and your summary names every major you took and every one you left, with the reason.`,
};

// knip's counts folded into one chore rather than split by kind: unused files, exports and dependencies are the
// same finding, fixed in one pass.
const deadCode: Chore = {
    id: `dead-code`,
    title: `Clear out dead code`,
    icon: `trash`,
    description: `Files, exports and dependencies nothing in this repository references any more.`,
    kind: `accruing`,
    criterion: `knip reports at least one unreferenced file, export or dependency.`,
    applies: (signals) => (signals.shape.packageManifest ? undefined : `no package.json`),
    stance: `act`,
    needs: [`knip`],
    cadenceMs: 14 * DAY_MS,
    automation: {
        cron: `0 3 * * *`,
        // Two gates so a repo that never adopted knip reads differently from one that's clean; `pnpm exec` resolves the
        // repo's own devDependency.
        guard:
            `pnpm exec knip --version >/dev/null 2>&1 || { echo "knip is not a devDependency of this repo"; exit 1; }; ` +
            `pnpm exec knip --reporter json > ${KNIP_REPORT} && { echo "no dead code"; exit 1; }`,
        note: `nightly · wakes only on findings`,
        report: KNIP_REPORT,
        woke: `knip's findings for this workspace are in ${KNIP_REPORT} (JSON), and it woke you because there are some.`,
    },
    assess: (context) => {
        const facts = factsOf(context, `knip`);
        if (facts === undefined) {
            return undefined;
        }
        const { files, exports, types, dependencies: unusedDeps, devDependencies, sample } = facts.deadCode;
        const total = files + exports + types + unusedDeps + devDependencies;
        if (total === 0) {
            return undefined;
        }
        return {
            headline: `${plural(files, `unreferenced file`)}, ${plural(exports + types, `unused export`)}, ${plural(unusedDeps + devDependencies, `unused dependency`, `unused dependencies`)}`,
            detail: sample.map((path) => `unreferenced · ${path}`),
            // File identities carry the news (a newly-dead file is an event); export/dependency counts ride along
            // bucketed, since they drift constantly.
            digest: digestOf(...sample.toSorted(), `exports:${bucketOf(exports + types)}`, `deps:${bucketOf(unusedDeps + devDependencies)}`),
            severity: `info`,
            // The sample, not the full list: this measurement is hours old, and the goal tells the agent to re-run knip
            // for the rest.
            why:
                `knip reports ${plural(files, `unreferenced file`)}, ${exports + types} unused exports and ` +
                `${unusedDeps + devDependencies} unused dependencies in ${repoLabel(context.repo)}` +
                `${sample.length === 0 ? `` : `, among them ${sample.join(`, `)}`}.`,
        };
    },
    diagnosis: `Code nothing reaches still has to be read, type-checked and kept compiling by everyone who works nearby.`,
    goal:
        `Re-run knip yourself first: this measurement is hours old and the tree has moved. Then check each finding against how the ` +
        `file is actually used: knip is confidently wrong about anything reachable from OUTSIDE the repository, which means a package's ` +
        `public entry points, files a bundler or framework loads by convention, and types consumed only by a downstream package. Delete ` +
        `what is genuinely unreachable. Leave the false positives and list them in one line each, so the next run's reader knows they ` +
        `were considered rather than missed.`,
    done: `Done when knip reports fewer findings, the repository's type-check and tests pass, and nothing you deleted is reachable from another package.`,
};

// Report-stance: most duplication shouldn't be removed (generated files, deliberate test repetition, lookalikes
// with different owners); deciding which copies must change together is a design judgement no unattended agent should
// make.
const DUPLICATION_FLOOR = 5;

const duplication: Chore = {
    id: `duplication`,
    title: `Find duplication worth collapsing`,
    icon: `clone`,
    description: `Copy-paste that has grown past a fifth of a percent of the tree. Reports only, extracting is a design call.`,
    kind: `drifting`,
    criterion: `jscpd reports more than 5% of the scanned tree duplicated.`,
    stance: `report`,
    needs: [`jscpd`],
    cadenceMs: 30 * DAY_MS,
    automation: {
        cron: `0 3 * * 1`,
        // Gated on the percentage, not "any clone at all" (which every repo has); below this the report is noise.
        guard:
            `pnpm dlx jscpd ${WORKSPACE_ROOT_JSCPD_EXCLUDE_ARG} --reporters json --output ${JSCPD_DIR} --min-lines 12 --threshold 100 . >/dev/null 2>&1; ` +
            `[ "$(jq '.statistics.total.percentage // 0 | floor' ${JSCPD_REPORT} 2>/dev/null || echo 0)" -ge ${DUPLICATION_FLOOR} ]`,
        note: `weekly · wakes above ${DUPLICATION_FLOOR}% duplication`,
        report: JSCPD_REPORT,
        woke: `jscpd's clone report for this workspace is in ${JSCPD_REPORT}, and it woke you because duplication is above ${DUPLICATION_FLOOR}%.`,
    },
    assess: (context) => {
        const facts = factsOf(context, `jscpd`);
        if (facts === undefined || facts.duplication.percentage < DUPLICATION_FLOOR) {
            return undefined;
        }
        const { percentage, clones, top } = facts.duplication;
        return {
            headline: `${percentage.toFixed(1)}% of the tree is duplicated, across ${plural(clones, `clone`)}`,
            detail: top.map((clone) => `${clone.lines} lines · ${clone.first} ↔ ${clone.second}`),
            // A whole percentage point is the smallest move worth calling news; the biggest clones' identities carry
            // the rest.
            digest: digestOf(`pct:${Math.round(percentage)}`, ...top.map((clone) => `${clone.first}|${clone.second}`).toSorted()),
            severity: `info`,
            why:
                `jscpd reports ${percentage.toFixed(1)}% duplication across ${plural(clones, `clone`)} in ${repoLabel(context.repo)}; ` +
                `the largest are ${top.map((clone) => `${clone.first} ↔ ${clone.second} (${clone.lines} lines)`).join(`; `)}.`,
        };
    },
    diagnosis: `Duplication only costs anything when the copies have to change together, and only some of it does.`,
    goal:
        `Report the clones where the copies genuinely have to change together. For each: cite both file:line ranges, say what the shared ` +
        `concept actually is, and name where the extraction would live. Then say explicitly which of the reported clones you are NOT ` +
        `recommending against: generated files, deliberately repetitive tests, and lookalikes owned by different subsystems, so the ` +
        `next reader knows the list was triaged rather than truncated.`,
    done: `Done when every clone in the report has either a named extraction or a one-line reason it should stay.`,
};

// The only chore whose evidence is about the tests, not the code: a green suite proves a line ran, not that
// anything depended on what it produced. The floor is set low on purpose, to catch decorative suites, not to grade good
// ones.
const MUTATION_FLOOR = 60;

const testStrength: Chore = {
    id: `test-strength`,
    title: `Strengthen tests that would not notice a bug`,
    icon: `list-check`,
    description: `Whether the suite would actually fail if the code broke, which is a different question from whether it passes.`,
    kind: `accruing`,
    criterion: `Stryker's mutation score for the repo is under ${MUTATION_FLOOR}%.`,
    stance: `act`,
    needs: [`mutation`],
    // Weekly: `--incremental` makes this affordable, the first run costs a full run, every one after costs only what
    // changed.
    cadenceMs: 7 * DAY_MS,
    assess: (context) => {
        const facts = factsOf(context, `mutation`);
        if (facts === undefined || facts.mutation.score >= MUTATION_FLOOR) {
            return undefined;
        }
        const { score, killed, survived, survivors } = facts.mutation;
        return {
            headline: `${survived} injected faults went unnoticed, ${score}% of them caught`,
            // The survivors themselves, not the score; a named line with the change nothing objected to is a morning's
            // work already.
            detail: survivors.map((one) => `${one.file}:${one.line} · ${one.mutator} → ${one.replacement} · survived`),
            // Bucketed so ordinary score drift isn't news; survivors' identities ride along, so a new weak spot speaks
            // even at a steady score.
            digest: digestOf(`bucket:${bucketOf(100 - score)}`, ...survivors.map((one) => `${one.file}:${one.line}`).toSorted()),
            severity: `info`,
            why:
                `Stryker caught ${killed} of ${killed + survived} injected faults in ${repoLabel(context.repo)} (${score}%), under the ${MUTATION_FLOOR}% floor. ` +
                `Code that can be changed with every test still green: ${survivors.map((one) => `${one.file}:${one.line} (${one.mutator} → ${one.replacement})`).join(`; `)}.`,
        };
    },
    diagnosis: `Tests that run the code without checking what it produced pass whether or not the code is right, and no other check in this repository can tell the difference.`,
    goal:
        `Take the survivors one at a time and, for each, decide which of two things it is. Either the mutation changes behaviour somebody ` +
        `depends on, in which case add the assertion that would have failed — usually at a BOUNDARY, and usually exact where the existing ` +
        `test was relational: pinning \`bucketOf(0)\` to its value catches what \`not.toBe(bucketOf(1))\` cannot. Or it is an equivalent ` +
        `mutant, code whose change genuinely cannot be observed, in which case say so and leave it. Do not chase the percentage: adding an ` +
        `assertion nobody needs to satisfy a number is exactly the ceremony this is meant to detect.`,
    done: `Done when every named survivor has either a new assertion that fails without the change, or a one-line note saying why it cannot be observed.`,
};

// Evidence is a package with no README, which is its architecture document here. The digest is the set of
// undocumented directories, so a long-standing backlog goes quiet after being seen once.
const documentation: Chore = {
    id: `documentation-refresh`,
    title: `Document what nothing explains`,
    icon: `file-edit`,
    description: `Packages in this repository with no README, new ones first.`,
    kind: `drifting`,
    criterion: `A workspace package has no README.`,
    applies: (signals) => (signals.packages.length > 0 ? undefined : `not a workspace`),
    stance: `act`,
    needs: [],
    cadenceMs: 90 * DAY_MS,
    assess: (context) => {
        const undocumented = context.signals.packages.filter((entry) => !entry.documented);
        if (undocumented.length === 0) {
            return undefined;
        }
        return {
            headline: `${plural(undocumented.length, `package`)} of ${context.signals.packages.length} have no document`,
            detail: undocumented.map((entry) => `${entry.name} · ${entry.dir}`),
            digest: digestOf(...undocumented.map((entry) => entry.dir).toSorted()),
            severity: `info`,
            why:
                `${plural(undocumented.length, `package`)} of ${context.signals.packages.length} in ${repoLabel(context.repo)} have no ` +
                `README: ${undocumented.map((entry) => entry.dir).join(`, `)}.`,
        };
    },
    diagnosis: `A package nobody can read the shape of gets worked in by guesswork, and the guesses accumulate.`,
    goal:
        `Follow this workspace's own documentation conventions: read them first, they are not optional and they are not generic. For ` +
        `each undocumented package, read the package before you write a word about it, and produce the document its conventions call ` +
        `for: what the package is FOR, how it fits the system, and which files matter. Explain at the module level. Never describe code ` +
        `line by line, and never document a package you did not read.`,
    done: `Done when every package you named has a document that a newcomer could use to find the file they need, and no other file changed.`,
};

// Reports only the two shapes worth arguing about in a hotspot ranking:
// - volatile and depended-on: a hotspot that is also a key module, every edit ripples outward.
// - out of proportion: branching three times the median of its own ranking.
const COMPLEXITY_MULTIPLE = 3;

const median = (values: readonly number[]): number => {
    if (values.length === 0) {
        return 0;
    }
    const sorted = values.toSorted((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
};

const complexity: Chore = {
    id: `complexity`,
    title: `Simplify what everything waits on`,
    icon: `wave-pulse`,
    description: `Files that both churn and carry the repository, where edits are slow and ripple outward.`,
    kind: `accruing`,
    criterion: `A file in the hotspot ranking is also a key module, or its branching is three times the median of that ranking.`,
    stance: `act`,
    needs: [],
    cadenceMs: 30 * DAY_MS,
    assess: (context) => {
        // A half-built index ranks whatever it has finished reading, not the repository; better to say nothing than
        // target the wrong file.
        if (!context.signals.indexed || context.signals.hotspots.length === 0) {
            return undefined;
        }
        const keyModules = new Set(context.signals.keyModules.map((module) => module.path));
        const middle = median(context.signals.hotspots.map((hotspot) => hotspot.complexity));
        const found = context.signals.hotspots.filter(
            (hotspot) => keyModules.has(hotspot.path) || hotspot.complexity >= middle * COMPLEXITY_MULTIPLE,
        );
        if (found.length === 0) {
            return undefined;
        }
        const reason = (path: string, branches: number): string =>
            keyModules.has(path) ? `churns and the rest of the repository imports it` : `${branches} branch points against a median of ${middle}`;
        return {
            headline: `${plural(found.length, `file`)} where every edit is slow and ripples outward`,
            detail: found.map((hotspot) => `${hotspot.path}, ${hotspot.commits} commits, ${reason(hotspot.path, hotspot.complexity)}`),
            digest: digestOf(...found.map((hotspot) => hotspot.path).toSorted()),
            severity: `info`,
            why:
                `${plural(found.length, `file`)} in ${repoLabel(context.repo)} are both change magnets and structurally tangled: ` +
                `${found.map((hotspot) => `${hotspot.path} (${hotspot.commits} commits, ${hotspot.complexity} branch points)`).join(`; `)}.`,
        };
    },
    diagnosis: `A file that changes constantly and branches heavily makes every edit near it slow and easy to get wrong.`,
    goal:
        `Take ONE file: the worst of them, and no more. Read it first. If the rest of the repository imports it, separate the stable ` +
        `contract from the churn: a narrow surface for importers, the volatile implementation private behind it. If it is simply ` +
        `tangled, flatten it where it stands: edge cases as early returns, compound conditions behind named predicates, long chains as ` +
        `lookups, and extract a unit only if a cohesive one falls out. Behaviour stays identical, and no re-export shims are left behind.`,
    done: `Done when \`iq hotspots\` reports materially fewer branch points for that file, the repository's checks pass, and no importer changed meaning.`,
};

// A static table, current only as of this file's last edit; no network call. Source: nodejs/Release.
const NODE_EOL: Readonly<Record<number, string>> = {
    16: `2023-09-11`,
    18: `2025-04-30`,
    20: `2026-04-30`,
    22: `2027-04-30`,
    24: `2028-04-30`,
};
// How far ahead of end-of-life the chore starts speaking; a quarter, since moving a runtime is planned work.
const EOL_HORIZON_MS = 90 * DAY_MS;

const runtime: Chore = {
    id: `runtime-eol`,
    title: `Move off an end-of-life runtime`,
    icon: `bolt`,
    description: `Whether the Node this sandbox runs still receives security patches.`,
    kind: `carrying`,
    criterion: `The Node release this sandbox runs is past its end-of-life date, or within 90 days of it.`,
    applies: (signals) => (signals.shape.packageManifest ? undefined : `no package.json`),
    stance: `act`,
    needs: [],
    cadenceMs: 0,
    assess: (context) => {
        const major = Number.parseInt(context.node.replace(/^v/, ``), 10);
        const eol = NODE_EOL[major];
        if (Number.isNaN(major) || eol === undefined) {
            return undefined;
        }
        const eolMs = Date.parse(`${eol}T00:00:00Z`);
        if (context.nowMs < eolMs - EOL_HORIZON_MS) {
            return undefined;
        }
        const past = context.nowMs >= eolMs;
        const days = Math.round(Math.abs(eolMs - context.nowMs) / DAY_MS);
        // Which packages would have to be argued with, so the finding names the work, not just the fact.
        const pinned = context.signals.packages.filter((entry) => entry.engines?.[`node`] !== undefined);
        return {
            headline: past
                ? `Node ${major} stopped receiving security patches ${days} days ago`
                : `Node ${major} reaches end of life in ${days} days`,
            detail: [
                `running · ${context.node}`,
                `end of life · ${eol}`,
                ...pinned.map((entry) => `pinned · ${entry.name} requires node ${entry.engines?.[`node`] ?? ``}`),
            ],
            // The state, not the date: a countdown would mint a new digest, and badge, every single day.
            digest: digestOf(`node:${major}`, past ? `eol` : `approaching`),
            severity: past ? `warning` : `info`,
            why:
                `This sandbox runs ${context.node}, and Node ${major} ${past ? `reached end of life on ${eol}` : `reaches end of life on ${eol}`}, ` +
                `${plural(pinned.length, `package`)} in ${repoLabel(context.repo)} pin a node engine range.`,
        };
    },
    diagnosis: `An unsupported runtime stops receiving security patches, so every advisory against it stays open permanently.`,
    goal:
        `Establish what actually pins this runtime: the image's own base, the workspace's nodeVersion, and each package's engines ` +
        `range. Propose the smallest move to a supported LTS, which of those pins have to change, in what order, and what is likely to ` +
        `break at that boundary. Make the pin changes that are mechanical; do NOT attempt the image rebuild itself.`,
    done: `Done when the pins name a supported release, the repository's type-check and tests pass on it, and anything needing a rebuild is named as such.`,
};

// Evidence for a question usually asked as a vibe: two libraries solving the same problem is a fact, not an
// opinion. The table is short, naming only categories where having two is a genuine mistake, not an ordinary migration.
const CATEGORIES: readonly { readonly category: string; readonly members: readonly string[] }[] = [
    { category: `date handling`, members: [`moment`, `dayjs`, `date-fns`, `luxon`, `js-joda`] },
    { category: `HTTP clients`, members: [`axios`, `got`, `node-fetch`, `superagent`, `undici`, `request`] },
    { category: `schema validation`, members: [`zod`, `yup`, `joi`, `ajv`, `superstruct`, `valibot`] },
    { category: `utility belts`, members: [`lodash`, `underscore`, `ramda`, `remeda`] },
    { category: `state stores`, members: [`redux`, `mobx`, `zustand`, `jotai`, `recoil`, `pinia`, `valtio`] },
    { category: `UUID generation`, members: [`uuid`, `nanoid`, `cuid`, `shortid`, `ulid`] },
    { category: `test runners`, members: [`jest`, `mocha`, `ava`, `tap`] },
];

const libraries: Chore = {
    id: `library-overlap`,
    title: `Settle on one library per job`,
    icon: `box`,
    description: `Two dependencies solving the same problem, both shipped, both maintained, one picked at random.`,
    kind: `drifting`,
    criterion: `Two or more installed dependencies do the same job.`,
    applies: (signals) => (signals.packages.length > 0 ? undefined : `not a workspace`),
    stance: `report`,
    needs: [],
    cadenceMs: 90 * DAY_MS,
    assess: (context) => {
        const installed = new Set(context.signals.packages.flatMap((entry) => [...entry.dependencies, ...entry.devDependencies]));
        const collisions = CATEGORIES.map(({ category, members }) => ({ category, found: members.filter((member) => installed.has(member)) })).filter(
            ({ found }) => found.length > 1,
        );
        if (collisions.length === 0) {
            return undefined;
        }
        return {
            headline: `${plural(collisions.length, `job`)} done by more than one library`,
            detail: collisions.map(({ category, found }) => `${category} · ${found.join(`, `)}`),
            digest: digestOf(...collisions.map(({ category, found }) => `${category}:${found.toSorted().join(`+`)}`).toSorted()),
            severity: `info`,
            why:
                `${repoLabel(context.repo)} depends on more than one library for the same job: ` +
                `${collisions.map(({ category, found }) => `${category} (${found.join(`, `)})`).join(`; `)}.`,
        };
    },
    diagnosis: `Two libraries for one job means both ship, both need upgrading, and new code picks whichever the neighbouring file used.`,
    goal:
        `For each overlapping pair, find out which one is actually used. How many call sites each has, whether one is a ` +
        `transitive dependency nobody chose, and whether either is unmaintained. Recommend the one to keep and estimate the migration ` +
        `honestly, including the call sites where the two libraries genuinely differ in behaviour. Where the overlap is deliberate or ` +
        `the second is only transitive, say so and close the question.`,
    done: `Done when every overlapping pair has a recommendation with a call-site count behind it, or a reason the overlap is fine.`,
};

// Four chores that only exist where a UI framework does; gated on `shape.deps`, not `signals.packages` (empty
// for a non-monorepo app, which would leave the gate permanently and silently dark). All four catch things nobody sees
// the whole of at once: a component, a class name, a bundle chunk.

// How many evidence rows a UI finding lists before it is a wall, not a list; the standing count still leads the
// headline.
const DETAIL_LIMIT = 8;

const FRAMEWORK_LABELS = UI_FRAMEWORKS.map((framework) => framework.label).join(`, `);

// One gate, one cause, four chores; built from the framework table so a framework added to stack.ts can't leave
// a stale name behind in the reason.
const needsFramework = (signals: ChoreSignals): string | undefined =>
    frameworksOf(signals.shape.deps).length > 0 ? undefined : `no ${FRAMEWORK_LABELS}`;

const bytesLabel = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} kB`);

// The criterion is a share of total size, not a byte threshold, since a byte value would need a different number
// per app. Report-stance: where to split is a product decision no unattended agent should make.
const BUNDLE_SHARE_FLOOR = 50;
// Below this there is no ranking to be an outlier in; the largest asset is over half by arithmetic, not by fault.
const BUNDLE_MIN_ASSETS = 3;

// Strips a build asset's content hash (`vendor-DlAUqK2U.js` → `vendor.js`) so the digest doesn't change on every
// build; long and specific enough to leave `vendor-react.js` alone but catch Vite's and webpack's hash formats.
const stableAsset = (path: string): string => path.replace(/[.-](?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{8,}(\.[a-z0-9]+)$/, `$1`);

const bundleWeight: Chore = {
    id: `bundle-weight`,
    title: `Split what the browser downloads first`,
    icon: `download`,
    description: `What the last build put on disk, and whether it arrives as one download or several.`,
    kind: `accruing`,
    criterion: `A single asset is more than half of the build's total transfer size.`,
    applies: needsFramework,
    stance: `report`,
    needs: [`bundle`],
    cadenceMs: 30 * DAY_MS,
    assess: (context) => {
        const facts = factsOf(context, `bundle`);
        if (facts === undefined) {
            return undefined;
        }
        const { assets, totalGzip, dir } = facts.bundle;
        if (assets.length < BUNDLE_MIN_ASSETS || totalGzip === 0) {
            return undefined;
        }
        // By gzip, not raw bytes: what's on disk isn't what crosses the wire, and a compressible asset isn't the
        // download this is about.
        const ranked = assets.toSorted((left, right) => right.gzip - left.gzip);
        const largest = ranked[0];
        if (largest === undefined) {
            return undefined;
        }
        const share = (largest.gzip / totalGzip) * 100;
        if (share < BUNDLE_SHARE_FLOOR) {
            return undefined;
        }
        return {
            headline: `${largest.path} is ${Math.round(share)}% of the ${bytesLabel(totalGzip)} this build ships`,
            detail: ranked
                .slice(0, DETAIL_LIMIT)
                .map((asset) => `${bytesLabel(asset.gzip)} gzipped · ${asset.path} (${bytesLabel(asset.bytes)} on disk)`),
            // The bucketed total and hash-stripped identities of the biggest chunks; a rebuild of the same code stays
            // silent, a new heavy chunk doesn't.
            digest: digestOf(
                `total:${bucketOf(totalGzip)}`,
                ...ranked
                    .slice(0, 5)
                    .map((asset) => stableAsset(asset.path))
                    .toSorted(),
            ),
            // Not a risk being carried, however large; `warning` is reserved for something with a clock on it.
            severity: `info`,
            why:
                `The build output in ${dir}/ of ${repoLabel(context.repo)} is ${bytesLabel(totalGzip)} gzipped across ` +
                `${plural(assets.length, `asset`)}, and ${largest.path} alone is ${bytesLabel(largest.gzip)} of it: ${Math.round(share)}%. ` +
                `The next largest are ${ranked
                    .slice(1, 4)
                    .map((asset) => `${asset.path} (${bytesLabel(asset.gzip)})`)
                    .join(`, `)}. ` +
                `This is the last build someone ran, read off disk; nothing rebuilt it to measure.`,
        };
    },
    diagnosis: `Everything in the first chunk is downloaded and parsed before anything renders, whether or not the visitor needed it.`,
    goal:
        `Find out what is actually IN the dominant chunk before proposing anything: the repository's own bundler can report this, and a ` +
        `recommendation made without it is guesswork. Then report the split worth making: which routes or features could load on demand, ` +
        `which dependencies are pulled in wholesale for one function, and which are only used behind an interaction nobody has yet had. ` +
        `Name the boundary for each and estimate what it saves. Where the chunk is genuinely all first-paint code, say so and close it.`,
    done: `Done when every recommendation names a specific import boundary and the bytes it would move out of the first download.`,
};

// Digests the bucketed count per idiom, not file identities: a migration in progress is a set that changes
// constantly, so a new kind of legacy code appearing, or real progress through a bucket, is what speaks.
const frameworkIdiom: Chore = {
    id: `framework-idiom`,
    title: `Finish the framework migrations`,
    icon: `history`,
    description: `Code still written the way the framework used to recommend, long after it stopped.`,
    kind: `accruing`,
    criterion: `A file uses a framework idiom that framework's own maintainers have replaced.`,
    applies: needsFramework,
    stance: `act`,
    needs: [`ui`],
    cadenceMs: 60 * DAY_MS,
    assess: (context) => {
        const facts = factsOf(context, `ui`);
        if (facts === undefined) {
            return undefined;
        }
        // Drops rules for two cases: an idiom this build's daemon doesn't know about (a sandbox ahead of the browser),
        // and an idiom belonging to a framework this repository doesn't declare using (a probe scans every rule
        // everywhere).
        const frameworks = new Set(frameworksOf(context.signals.shape.deps).map((framework) => framework.id));
        const found = facts.scan.idioms.flatMap(({ id, files }) => {
            const rule = idiomRule(id);
            return rule === undefined || !frameworks.has(rule.framework) || files.length === 0 ? [] : [{ rule, files }];
        });
        if (found.length === 0) {
            return undefined;
        }
        const total = found.reduce((sum, entry) => sum + entry.files.length, 0);
        const ranked = found.toSorted((left, right) => right.files.length - left.files.length);
        return {
            headline: `${plural(found.length, `retired idiom`)} still in use, across ${plural(total, `file`)}`,
            detail: ranked.map((entry) => `${plural(entry.files.length, `file`)} · ${entry.rule.label} → ${entry.rule.replacement}`),
            digest: digestOf(...ranked.map((entry) => `${entry.rule.id}:${bucketOf(entry.files.length)}`).toSorted()),
            severity: `info`,
            why:
                `${repoLabel(context.repo)} still uses ${plural(found.length, `idiom`)} its framework has replaced: ` +
                `${ranked.map((entry) => `${entry.rule.label} in ${plural(entry.files.length, `file`)} (replaced by ${entry.rule.replacement})`).join(`; `)}. ` +
                `A sample of the files: ${ranked
                    .flatMap((entry) => entry.files.slice(0, 3))
                    .slice(0, DETAIL_LIMIT)
                    .join(`, `)}.`,
        };
    },
    diagnosis: `A retired idiom keeps working until the major release that drops it, and then it is an emergency inside somebody else's upgrade.`,
    goal:
        `Take ONE idiom, the one with the most files, and no more. Convert the files where the conversion is mechanical and the behaviour ` +
        `is provably identical. Stop at the first file that needs a design decision: a class component with genuine error-boundary ` +
        `semantics, an NgModule that something outside the repository imports: leave it, and say what it would take. Do not convert an ` +
        `idiom the repository has deliberately kept: if the newest code uses it too, that is a choice, and reporting it as one is the ` +
        `useful answer.`,
    done: `Done when a re-scan reports fewer files on that idiom, the repository's type-check and tests pass, and every file you skipped has a one-line reason.`,
};

// Two kinds of evidence: a name family catches components written separately that never shared a line; a clone
// pair catches unrelated names doing the same work. Needs jscpd rather than reading it if present, so it never claims
// to have looked when it hasn't.
const componentOverlap: Chore = {
    id: `component-overlap`,
    title: `Settle on one component per job`,
    icon: `copy`,
    description: `Components built twice, the same name in two places, or the same logic under two names.`,
    kind: `drifting`,
    criterion: `Two component files reduce to the same name, or a duplicated block spans two components.`,
    applies: needsFramework,
    stance: `report`,
    needs: [`ui`, `jscpd`],
    cadenceMs: 90 * DAY_MS,
    assess: (context) => {
        const ui = factsOf(context, `ui`);
        const jscpd = factsOf(context, `jscpd`);
        if (ui === undefined || jscpd === undefined) {
            return undefined;
        }
        const byStem = new Map<string, string[]>();
        for (const path of ui.scan.components) {
            const stem = componentStem(path);
            if (stem !== undefined) {
                byStem.set(stem, [...(byStem.get(stem) ?? []), normalizePath(path)]);
            }
        }
        const families = [...byStem]
            .filter(([, paths]) => paths.length > 1)
            .map(([stem, paths]) => ({ stem, paths: paths.toSorted() }))
            .toSorted((left, right) => right.paths.length - left.paths.length);
        // Only clones with a component on both sides; one shared with a utility module is the duplication chore's
        // finding, not this one.
        const inventory = new Set(ui.scan.components.map(normalizePath));
        const pairs = jscpd.duplication.top.filter(
            (clone) => inventory.has(normalizePath(clone.first)) && inventory.has(normalizePath(clone.second)),
        );
        if (families.length === 0 && pairs.length === 0) {
            return undefined;
        }
        const parts = [
            ...(families.length === 0 ? [] : [`${plural(families.length, `name`)} used by more than one component`]),
            ...(pairs.length === 0 ? [] : [`${plural(pairs.length, `clone`)} spanning two of them`]),
        ];
        return {
            headline: parts.join(`, `),
            detail: [
                ...families.slice(0, DETAIL_LIMIT).map((family) => `${family.stem} · ${family.paths.join(`, `)}`),
                ...pairs.map((clone) => `${clone.lines} shared lines · ${normalizePath(clone.first)} ↔ ${normalizePath(clone.second)}`),
            ],
            // Identities on both halves: every component joining or leaving a family, and every clone pair, is a new
            // fact, not drift.
            digest: digestOf(
                ...families.map((family) => `${family.stem}:${family.paths.join(`+`)}`).toSorted(),
                ...pairs.map((clone) => `${normalizePath(clone.first)}|${normalizePath(clone.second)}`).toSorted(),
            ),
            severity: `info`,
            why:
                `${repoLabel(context.repo)} has ${parts.join(` and `)}, out of ${plural(ui.scan.components.length, `component file`)} scanned. ` +
                `${
                    families.length === 0
                        ? ``
                        : `The names: ${families
                              .slice(0, DETAIL_LIMIT)
                              .map((family) => `${family.stem} (${family.paths.join(`, `)})`)
                              .join(`; `)}. `
                }` +
                `${pairs.length === 0 ? `` : `The clones: ${pairs.map((clone) => `${normalizePath(clone.first)} ↔ ${normalizePath(clone.second)}, ${clone.lines} lines`).join(`; `)}.`}`,
        };
    },
    diagnosis: `A component built twice is maintained once, whichever copy the next person happens to open is the one that gets the fix.`,
    goal:
        `Read every file in each group before saying anything about it; a shared name is a reason to look, not a finding on its own. For ` +
        `each group, say whether these genuinely do the same job, and if they do, name the one to keep and count the call sites that would ` +
        `have to move. Where the answer is that the same LOGIC is duplicated rather than the whole component: the same fetch and loading ` +
        `state, the same form validation, the same list virtualization written twice: say so, and name the hook or composable it should ` +
        `become and where it would live. Where two components share a name and nothing else, say that too and close it: a false family is ` +
        `worth one line, and the next reader needs to know it was considered.`,
    done: `Done when every group has either a component to keep with a call-site count, a shared unit to extract with a home, or a reason it is fine.`,
};

// Only colours and pixel sizes, not every arbitrary value (`grid-cols-[1fr_auto]` is the feature working as
// intended); those are the two things the theme already has an answer for.
const tailwindBypass: Chore = {
    id: `tailwind-arbitrary-values`,
    title: `Put hard-coded styles back on the scale`,
    icon: `palette`,
    description: `Colours and sizes written inline in the markup, around the theme that already defines them.`,
    kind: `drifting`,
    criterion: `A Tailwind class hard-codes a colour or a pixel size instead of using the theme's scale.`,
    applies: (signals) => (usesTailwind(signals.shape.deps) ? undefined : `no Tailwind`),
    stance: `act`,
    needs: [`ui`],
    cadenceMs: 30 * DAY_MS,
    assess: (context) => {
        const facts = factsOf(context, `ui`);
        if (facts === undefined) {
            return undefined;
        }
        const { bypasses } = facts.scan;
        if (bypasses.length === 0) {
            return undefined;
        }
        const total = bypasses.reduce((sum, entry) => sum + entry.count, 0);
        const worst = bypasses.toSorted((left, right) => right.count - left.count).slice(0, DETAIL_LIMIT);
        return {
            headline: `${plural(total, `hard-coded value`)} across ${plural(bypasses.length, `file`)}`,
            detail: worst.map((entry) => `${entry.path} · ${plural(entry.count, `value`)}`),
            // Worst files by identity lead; the spread and total ride along bucketed, since both drift by one with
            // every markup edit.
            digest: digestOf(...worst.map((entry) => entry.path).toSorted(), `files:${bucketOf(bypasses.length)}`, `total:${bucketOf(total)}`),
            severity: `info`,
            why:
                `${repoLabel(context.repo)} has ${plural(total, `Tailwind class`, `Tailwind classes`)} hard-coding a colour or a pixel size ` +
                `across ${plural(bypasses.length, `file`)}; the heaviest are ` +
                `${worst
                    .slice(0, 5)
                    .map((entry) => `${entry.path} (${entry.count})`)
                    .join(`, `)}.`,
        };
    },
    diagnosis: `Every inline colour is a place the theme cannot reach, a palette change lands everywhere except the files that opted out of it.`,
    goal:
        `Read the theme first: the Tailwind config, or the CSS that defines the tokens, so you know what the scale actually offers. Then ` +
        `replace the values that have a token: an exact palette match, a spacing step, a type size. Where a value is CLOSE to a token but ` +
        `not equal, do not round it silently; that is a visual change wearing a refactor's clothes. List those separately with both values ` +
        `and let the owner decide. Where a value has no token and should: a brand colour used in nine places, say that the theme is ` +
        `missing an entry rather than editing nine files.`,
    done: `Done when a re-scan reports fewer hard-coded values, nothing renders differently, and every value you left has a one-line reason.`,
};

// Chores with no measurement at all, triggered by the calendar; the ledger is what makes that trigger honest.
// All are report-stance. `applies` matters more here than for a measured chore: a survey has no evidence to be absent,
// so an ungated one fires everywhere, forever.
interface SurveySpec {
    readonly id: string;
    readonly title: string;
    readonly icon: string;
    readonly description: string;
    readonly diagnosis: string;
    readonly goal: string;
    readonly done: string;
    readonly cadenceDays: number;
    // What must exist for this review to have a subject; required, not optional, since a survey that applies everywhere
    // must say so explicitly.
    readonly applies: (signals: ChoreSignals) => string | undefined;
}

const survey = ({ id, title, icon, description, diagnosis, goal, done, cadenceDays, applies }: SurveySpec): Chore => ({
    id,
    title,
    icon,
    description,
    // Not a SurveySpec parameter: a survey has no measurement, so "due because it has been that long" is the surveying
    // kind.
    kind: `surveying`,
    criterion: `${cadenceDays} days have passed since this review was last run.`,
    applies,
    stance: `report`,
    needs: [],
    cadenceMs: cadenceDays * DAY_MS,
    survey: true,
    // A survey's evidence is that time passed, so the digest is the period it is due for: one badge per cadence window.
    assess: (context) => ({
        headline: `Not surveyed in ${cadenceDays} days`,
        detail: [`Cadence · every ${cadenceDays} days`],
        digest: digestOf(id, `period:${Math.floor(context.nowMs / (cadenceDays * DAY_MS))}`),
        severity: `info`,
        why: `This is a periodic review of ${repoLabel(context.repo)}, run every ${cadenceDays} days; nothing measured it, it is due because it has been that long.`,
    }),
    diagnosis,
    goal,
    done,
});

// Below this a repo is too small for cross-cutting patterns to have diverged; counted in indexed files so a config-only
// scaffold doesn't pass by accident.
const PATTERNS_FLOOR = 25;

const patterns = survey({
    id: `standardize-patterns`,
    title: `Standardize the cross-cutting patterns`,
    icon: `sitemap`,
    description: `Error handling, validation, logging, configuration, retries, pagination, the things every file does slightly differently.`,
    diagnosis: `Cross-cutting concerns drift one file at a time, and the cost only shows up when someone has to work across several of them.`,
    goal:
        `Pick the cross-cutting concerns this repository actually has: error handling, input validation, logging, configuration, retries, ` +
        `pagination, serialization, and for each, survey how it is done. Name the dominant pattern, the outliers, and which of the ` +
        `outliers are deliberate. Recommend ONE convention per concern with a file to point at as the reference implementation, and ` +
        `estimate the size of the conversion. Do not convert anything.`,
    done: `Done when each concern has a named convention, a reference file, and a count of the sites that diverge from it.`,
    cadenceDays: 90,
    // The one cause that is a measurement, not an absence; every size-gated chore uses this same string so they group
    // together.
    applies: (signals) => (signals.totals.files >= PATTERNS_FLOOR ? undefined : `only ${signals.totals.files} indexed files`),
});

const deprecated = survey({
    id: `deprecated-apis`,
    title: `Audit deprecated APIs`,
    icon: `exclamation-triangle`,
    description: `Language, runtime and framework APIs this code still uses that their own maintainers have moved on from.`,
    diagnosis: `A deprecated API works right up until the upgrade that removes it, and then it is an emergency during someone else's migration.`,
    goal:
        `Survey what this repository uses that its own dependencies have deprecated: read the framework and runtime versions in use, check ` +
        `their deprecation notices, and search for the call sites. Include the repository's OWN deprecations: anything its code marks ` +
        `as deprecated and still calls. Rank by when each one actually breaks, not by how many call sites it has, and name the ` +
        `replacement for each. Change nothing.`,
    done: `Done when every deprecation has call sites cited, a replacement named, and the release it is expected to break in.`,
    cadenceDays: 90,
    applies: (signals) => (signals.shape.packageManifest ? undefined : `no package.json`),
});

// Gated on the docs map existing, not the directory: an empty docs/architecture/ is undocumented too. Also
// reads the package READMEs, but a repo with no map hasn't been documented at all.
const documentationDrift = survey({
    id: `documentation-drift`,
    title: `Re-read the documentation against the code`,
    icon: `file`,
    description: `Whether what the documents claim is still what the code does, the drift no tool can measure.`,
    diagnosis: `Documentation is trusted in proportion to how recently it was true, and a document that is quietly wrong is worse than a missing one.`,
    goal:
        `Read this repository's architecture documents against the code they describe. Report every claim that is no longer true, citing the ` +
        `document line and the file that contradicts it. Prioritise the claims someone would ACT on, where a subsystem lives, what owns ` +
        `what, which file to change: over prose that has merely aged. Do not rewrite the documents; produce the list of what is wrong.`,
    done: `Done when every architecture document has been read and every false claim is listed with both sides cited.`,
    cadenceDays: 90,
    applies: (signals) => (signals.shape.docs.length > 0 ? undefined : `no architecture documents`),
});

// Both surveys, since nothing here can measure pipeline caching or image bloat without running them; gated on
// the artefact itself so a repo with neither doesn't sit permanently due.
const pipelines = survey({
    id: `ci-hygiene`,
    title: `Tighten the CI pipeline`,
    icon: `bolt`,
    description: `What the pipeline re-does every run: uncached installs, rebuilt layers, jobs that could run in parallel.`,
    diagnosis: `A slow pipeline is paid on every push by everyone, and it degrades one uncached step at a time without anyone deciding to.`,
    goal:
        `Read this repository's pipeline definitions and report what it pays for repeatedly: dependency installs with no cache key, ` +
        `build outputs recomputed between jobs, steps that are serial for no reason, and matrix legs that duplicate each other's work. ` +
        `For each, name the file and step, say roughly what it costs per run, and give the change that would fix it. Where a step is slow ` +
        `because it genuinely has to be, say so: a pipeline that is honestly expensive is not a finding.`,
    done: `Done when every finding names a file, a step, and a concrete change, and anything deliberately slow is called out as such.`,
    cadenceDays: 90,
    applies: (signals) => (signals.shape.ci.length > 0 ? undefined : `no CI pipeline`),
});

const images = survey({
    id: `docker-image`,
    title: `Slim the container image`,
    icon: `box`,
    description: `Layer order, build context and final size, what ships in the image that did not need to.`,
    diagnosis: `Image size is paid on every pull and every cold start, and layer order decides how much of a build is cache hits.`,
    goal:
        `Read this repository's Dockerfiles and report what makes the image larger or the build slower than it needs to be: layers ordered ` +
        `so that a source edit invalidates the dependency install, build-time toolchains left in the final stage, a build context that ships ` +
        `the whole repository, and package caches never cleaned. For each, cite the file and line, and name the change. Do not rewrite the ` +
        `Dockerfiles: an image that fails to build is a much worse problem than one that is larger than ideal.`,
    done: `Done when every finding cites a Dockerfile line and names the change, with the ones that would need a base-image swap called out separately.`,
    cadenceDays: 90,
    applies: (signals) => (signals.shape.dockerfiles.length > 0 ? undefined : `no Dockerfile`),
});

// The panel's reading order, as data rather than a hand-sorted array: `kind` orders the book and groups the
// panel's rows, `caption` argues for the grouping. Ordered by kind, not by which repository will see them; a
// non-applicable chore is dropped entirely, so the order never has holes.
export interface ChoreKindSpec {
    readonly kind: ChoreKind;
    // Title case, because the panel renders it as a group heading rather than as a sentence.
    readonly label: string;
    // Why these belong together, in the reader's terms, what the group is CLAIMING about the rows under it.
    readonly caption: string;
}

export const CHORE_KINDS: readonly ChoreKindSpec[] = [
    { kind: `carrying`, label: `Carrying`, caption: `a risk this repository is running today, someone else decides when it becomes urgent` },
    { kind: `accruing`, label: `Accruing`, caption: `cheap now, expensive later, and always getting later` },
    { kind: `drifting`, label: `Drifting`, caption: `the shape of the thing is diverging from the idea of it` },
    { kind: `surveying`, label: `Surveying`, caption: `periodic reads with nothing measuring them, due because it has been that long` },
];

// Declaration order decides nothing but order within a kind (the sort below is stable); this is where a chore
// is written, CHORE_KINDS is where it is ranked.
const BOOK: readonly Chore[] = [
    security,
    runtime,
    dependencies,
    deadCode,
    complexity,
    testStrength,
    bundleWeight,
    frameworkIdiom,
    documentation,
    duplication,
    libraries,
    componentOverlap,
    tailwindBypass,
    patterns,
    deprecated,
    documentationDrift,
    pipelines,
    images,
];

const KIND_ORDER: readonly ChoreKind[] = CHORE_KINDS.map(({ kind }) => kind);

// Sorted, not filtered into groups, so a kind missing from the list above sorts to the front, visible, instead of
// vanishing.
export const CHORES: readonly Chore[] = BOOK.toSorted((left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind));

export const choreById = (id: string): Chore | undefined => CHORES.find((chore) => chore.id === id);

// The prompt for one chore, built here rather than in the view, so the panel, the badge's tooltip and an
// unattended automation all describe the same turn.
// Same four parts as a finding-driven turn, with the guard's own report standing in for the finding, since at
// 3am there is no verdict to quote. Workspace-wide: an automation's guard runs at the root with no repo argument to
// scope it.
export const choreAutomationPrompt = (chore: Chore): string | undefined =>
    chore.automation === undefined
        ? undefined
        : composeAsk({
              subject: `${chore.title} across this workspace.`,
              why: `${chore.automation.woke} ${TRIAGE_NOTE}`,
              diagnosis: chore.diagnosis,
              goal: chore.goal,
              invariants: chore.stance === `act` ? CHORE_INVARIANTS : REPORT_INVARIANTS,
              done: chore.done,
          });

export const chorePrompt = (chore: Chore, finding: ChoreFinding, repo: string): string =>
    composeAsk({
        subject: `${chore.title} in ${repoLabel(repo)}.`,
        // The rule before the numbers: an agent told the criterion, not just the count, can report that the criterion
        // itself was wrong.
        why: `${finding.why} You were woken because: ${chore.criterion} ${TRIAGE_NOTE}`,
        diagnosis: chore.diagnosis,
        goal: chore.goal,
        invariants: chore.stance === `act` ? CHORE_INVARIANTS : REPORT_INVARIANTS,
        done: chore.done,
    });
