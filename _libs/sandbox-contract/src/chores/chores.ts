import type { Advisory, ChoreSignals, OutdatedPackage, ProbeId, ProbeResult } from "../schemas.js";
import { bucketOf, digestOf } from "./digest.js";
import { CHORE_INVARIANTS, composeAsk, REPORT_INVARIANTS, TRIAGE_NOTE } from "./prompt.js";

/* THE CHORE BOOK — what routine maintenance a repository is owed, and what has to be TRUE before we say so.
 *
 * Everything in here is a standing offer: work that is worth doing eventually, that nobody will ever put on a
 * sprint board, and that a person cannot notice is overdue by looking at their editor. The engineering problem is
 * not finding such work — any linter will hand you a thousand findings — it is deciding which of them is worth
 * interrupting somebody about, on a surface they will still be reading in six months.
 *
 * Three rules, and every entry below obeys all three:
 *
 * 1. DELTAS, NOT ABSOLUTES. "38 packages are undocumented" is a statistic; it will be true every day for a year,
 *    and a tile lit every day teaches the eye to stop seeing the rail. "A package appeared that nothing explains"
 *    is an event. So a chore's `digest` is built from the IDENTITIES of what it found — which packages, which
 *    advisories, which files — and the rail speaks when that set changes, not while it is merely non-empty. The
 *    standing count still shows inside the panel, next to the thing it describes, which is where a statistic
 *    belongs.
 *
 * 2. LEADER-RELATIVE, NOT TUNED. Nowhere in here is there a threshold that would need a different value for a
 *    Rust repo, a fresh scaffold, or a ten-year monolith — with one deliberate exception (duplication's 5%, which
 *    is a percentage of the tree and therefore already scale-free). "Three times the median of its own ranking"
 *    needs no calibration and cannot rot.
 *
 * 3. THE EVIDENCE IS THE TRUTH; THE LEDGER ONLY DEBOUNCES. Nothing here can be ticked off. A chore goes quiet
 *    because the measurement moved, which means someone fixing it by hand — or an unrelated change fixing it by
 *    accident — is registered exactly like a chore turn doing it. The ledger's only power is to stop the rail
 *    repeating itself about evidence a turn has already been spent on (verdict.ts).
 *
 * What is NOT here is as deliberate. There is no composite score, no letter grade, no "health: 78%". Those are
 * not comparable across projects, cannot be checked by the reader, and turn a set of specific, arguable findings
 * into one number nobody can act on. And no chore is ever created enabled-and-hidden: a chore that runs is a
 * turn that spends money and writes to the workspace, so it is either something the owner started or an
 * automation they can see in a list. */

export type ChoreStance = "act" | "report";

export interface ChoreContext {
    // Root-relative repo dir; the empty string is the workspace's own root repo.
    readonly repo: string;
    readonly probes: ReadonlyMap<ProbeId, ProbeResult>;
    readonly signals: ChoreSignals;
    // What the daemon is actually RUNNING, not what a manifest wishes for.
    readonly node: string;
    readonly nowMs: number;
}

// What a chore found, when it found anything. `undefined` from `assess` is the healthy case and the common one.
export interface ChoreFinding {
    // One line, in numbers, for the row. The reader decides from this whether to open anything.
    readonly headline: string;
    // The evidence itself, one claim per line — what the panel lists under the row, and what makes the headline
    // checkable rather than something to be believed.
    readonly detail: readonly string[];
    // The identity of THIS evidence. See digest.ts: it is what the rail's transitions are measured against.
    readonly digest: string;
    // `warning` is for a risk the owner is carrying right now — a live advisory, a runtime past its EOL. Everything
    // else is `info`, including large and ugly numbers, because "there is a lot of it" is not an emergency.
    readonly severity: "info" | "warning";
    // The numbers again, in the agent's terms, for the prompt's "Why:" line. Exact — the agent may recount them.
    readonly why: string;
}

export interface Chore {
    readonly id: string;
    readonly title: string;
    // An app icon name. Left as a plain string for the same reason the extension API leaves Activation.icon open:
    // this library must not depend on the UI kit to name a glyph.
    readonly icon: string;
    // The one-line standing description, shown whether or not the chore is currently due.
    readonly description: string;
    // Whether the turn is allowed to CHANGE anything. Not a hint — it selects the invariants block, and a
    // report-stance chore is told in words that editing would be a surprise.
    readonly stance: ChoreStance;
    // Probes that must have run and succeeded before this chore can be assessed at all. Missing ⇒ `unavailable`:
    // rendered greyed, never badged, and never mistaken for a clean result.
    readonly needs: readonly ProbeId[];
    /* How long until this is worth doing again REGARDLESS of what changed. For a measured chore this is a backstop
     * (evidence normally decides); for a survey chore it is the whole trigger, because "read this code with fresh
     * eyes" has no measurement and its value is entirely in being done periodically. */
    readonly cadenceMs: number;
    // A survey has no measurement: it is due on its cadence and clear otherwise. Named rather than inferred from
    // an empty `needs`, because the two are different claims and the panel says which one a row is.
    readonly survey?: true;
    /* THE SCHEDULED FORM, for the chores worth running unattended — what the Automations page offers as a
     * one-click "code chore", and the second way this book is consumed.
     *
     * The two modes are genuinely different and both are wanted. The Maintenance panel is EVIDENCE-driven: it
     * reads what the daemon already measured and offers a turn against a specific finding you can read first. An
     * automation is SCHEDULE-driven: it wakes on a clock, at 3am, with nobody watching. So an automation cannot
     * carry a finding — there is no verdict at fire time — and instead it carries a GUARD: a shell one-liner that
     * runs for free on the sandbox's own clock and exits non-zero to skip, so the half that costs a turn only
     * starts when there is something to start it for.
     *
     * `report` is where the guard leaves its findings. A guard's stdout is discarded on success (only a FAILING
     * guard's output survives, as the skip reason), so a file is how the free deterministic half hands what it
     * found to the expensive half. */
    readonly automation?: {
        readonly cron: string;
        readonly guard: string;
        readonly note: string;
        readonly report: string;
        // How the woken turn is told what it is looking at — the "Why:" line, in place of a finding.
        readonly woke: string;
    };
    readonly assess: (context: ChoreContext) => ChoreFinding | undefined;
    // The prompt's three variable parts (prompt.ts owns the shape). `diagnosis` says what the numbers MEAN, `goal`
    // says what shape to move towards — never a design — and `done` is falsifiable by the agent itself.
    readonly diagnosis: string;
    readonly goal: string;
    readonly done: string;
}

const DAY_MS = 86_400_000;

/* Where a scheduled chore's guard leaves its report for the woken turn to read. Under /tmp because they are
 * inputs to a turn that starts moments later, never something to keep — and deliberately the SAME paths the
 * probe runner uses, so a workspace that runs both does not keep two copies of the same measurement. */
const AUDIT_REPORT = `/tmp/intentic-chore-audit.json`;
const KNIP_REPORT = `/tmp/intentic-chore-knip.json`;
const JSCPD_DIR = `/tmp/intentic-chore-jscpd`;
const JSCPD_REPORT = `${JSCPD_DIR}/jscpd-report.json`;

// How a repo is named to a person and to an agent. "root" is the wire id the daemon's git and health routes
// already use for the workspace's own repository, and it is a word an agent would otherwise read as a directory
// called "root" — so it is spelled out here, once, rather than at every call site that builds a prompt.
export const repoLabel = (repo: string): string => (repo === `root` || repo === `` ? `the workspace root repository` : repo);

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

// One outdated dependency, as the panel lists it. The semver step leads, because it is what decides whether the
// row is a morning's work or a project.
const outdatedLine = (entry: OutdatedPackage): string => `${entry.kind} · ${entry.name} ${entry.current} → ${entry.latest}`;

// The `facts` of a probe that actually ran. Anything else — never run, unavailable, failed — reads as absent, so
// no assess() can accidentally treat an unmeasured repo as a measured clean one.
const factsOf = <T extends ProbeId>(context: ChoreContext, id: T): Extract<NonNullable<ProbeResult["facts"]>, { id: T }> | undefined => {
    const probe = context.probes.get(id);
    if (probe?.state !== `ok` || probe.facts === undefined || probe.facts.id !== id) {
        return undefined;
    }
    return probe.facts as Extract<NonNullable<ProbeResult["facts"]>, { id: T }>;
};

// ---- the entries -----------------------------------------------------------------------------------------------

const BLOCKING = new Set<Advisory["severity"]>([`critical`, `high`]);

/* SECURITY. The only chore with no cadence at all: an advisory is not something that becomes worth looking at
 * after thirty days, and there is nothing periodic about it. It is also the only one that reaches `warning`
 * routinely, which is exactly why the bar is critical-or-high and production-or-dev is carried through to the
 * prompt rather than flattened — a moderate advisory in a build-time-only tool badging red is how `warning` stops
 * meaning anything within a week. */
const security: Chore = {
    id: `security-advisories`,
    title: `Patch security advisories`,
    icon: `shield`,
    description: `Published advisories against this dependency tree, and the ones whose fix is a version bump.`,
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
                .map((advisory) => `${advisory.severity} · ${advisory.name} — ${advisory.title}${advisory.patched === undefined ? ` (no patch yet)` : ``}`),
            // Identities, not counts: every advisory that appears or is fixed is genuinely news, and there is no
            // ordinary drift here to absorb.
            digest: digestOf(...blocking.map((advisory) => `${advisory.name}@${advisory.severity}`).toSorted()),
            severity: production.length > 0 ? `warning` : `info`,
            // Named, not counted. "1 high advisory" tells an agent nothing it can act on, and the first thing it
            // would have to do is re-derive the list we already have — badly, because pnpm audit is slow and it
            // would be reading a different tree by then.
            why:
                `pnpm audit reports ${plural(blocking.length, `high or critical advisory`, `high or critical advisories`)} against ` +
                `${repoLabel(context.repo)} — ${production.length} reaching a production dependency path, ${patchable.length} with a published patched range: ` +
                `${blocking.map((advisory) => `${advisory.name} (${advisory.severity}${advisory.dev ? `, dev-only` : ``}${advisory.patched === undefined ? `, no patch` : `, fixed in ${advisory.patched}`})`).join(`; `)}.`,
        };
    },
    diagnosis: `An advisory with a published fix is a version bump someone has to actually make; one without is a risk to decide about.`,
    goal:
        `For each advisory, establish whether this workspace reaches the vulnerable code path at all — a transitive dependency of a ` +
        `build-time tool is a different problem from one in a running service. Where the fix is a version bump the lockfile can absorb, ` +
        `make it. Where it needs a real upgrade or has no patch published, leave it and say what it would take. Never rewrite ` +
        `application code to route around a CVE.`,
    done: `Done when \`pnpm audit\` reports fewer high/critical advisories than it did, and the repository's type-check and tests pass.`,
};

/* DEPENDENCIES. Majors are the finding; the total is context. A repo that is forty patch releases behind is a
 * morning's work and does not need a rail tile, while one major on a framework is a project — so the digest is
 * built from WHICH packages have a major waiting, and a new one appearing is the event. The total count rides
 * along bucketed (digest.ts) so that ordinary drift, which is constant, does not read as news. */
const OUTDATED_NOISE_FLOOR = 20;

const dependencies: Chore = {
    id: `dependencies-outdated`,
    title: `Update dependencies`,
    icon: `arrow-circle-up`,
    description: `How far behind the registry this tree has drifted, and which majors are waiting.`,
    stance: `act`,
    needs: [`outdated`],
    cadenceMs: 30 * DAY_MS,
    assess: (context) => {
        const facts = factsOf(context, `outdated`);
        if (facts === undefined) {
            return undefined;
        }
        const majors = facts.packages.filter((entry) => entry.kind === `major`);
        // Nothing major and a short tail is a healthy repository, not a chore. The floor is on the TOTAL rather
        // than on any one package because minors and patches are only worth a turn in bulk.
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
            // The majors are named because they are what the turn is actually about — the minors and patches are a
            // bulk operation the agent will enumerate itself, and listing four hundred of them here would bury it.
            why:
                `pnpm outdated reports ${plural(facts.packages.length, `dependency`, `dependencies`)} behind the registry in ` +
                `${repoLabel(context.repo)}, ${majors.length} of them by a major version` +
                `${majors.length === 0 ? `` : `: ${majors.map((entry) => `${entry.name} ${entry.current} → ${entry.latest}`).join(`; `)}`}.`,
        };
    },
    diagnosis: `Version drift is cheap to fix continuously and expensive to fix in one go, because the majors start depending on each other.`,
    goal:
        `Take the patch and minor upgrades in one pass — those are what the lockfile can absorb without argument. Then take the majors ` +
        `ONE AT A TIME, reading each one's changelog for breaking changes before you touch anything, and stop at the first one that ` +
        `needs more than a mechanical fix: leave it, and say what it would take. Do not batch majors; a failing test after eight of them ` +
        `is a bisect nobody wanted.`,
    done: `Done when the repository's type-check and tests pass, and your summary names every major you took and every one you left, with the reason.`,
};

/* DEAD CODE. knip's counts, folded into one chore rather than split by kind: unused files, unused exports and
 * unused dependencies are the same finding wearing three hats, they are fixed in one pass, and three rows that
 * light together are three chances to teach someone to ignore the rail. */
const deadCode: Chore = {
    id: `dead-code`,
    title: `Clear out dead code`,
    icon: `trash`,
    description: `Files, exports and dependencies nothing in this repository references any more.`,
    stance: `act`,
    needs: [`knip`],
    cadenceMs: 14 * DAY_MS,
    automation: {
        cron: `0 3 * * *`,
        // Two gates, so the two ways to not run are distinguishable in the run history: knip absent (a repo that
        // never adopted it) reads differently from knip clean. `pnpm exec` resolves the repo's own devDependency
        // rather than downloading a floating version that would disagree with its knip.json.
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
            headline: `${plural(files, `unreferenced file`)}, ${exports + types} unused exports, ${unusedDeps + devDependencies} unused dependencies`,
            detail: sample.map((path) => `unreferenced · ${path}`),
            // The file identities carry the news (a newly-dead file is an event); the export and dependency counts
            // ride along bucketed, since they drift by one constantly as code is written.
            digest: digestOf(...sample.toSorted(), `exports:${bucketOf(exports + types)}`, `deps:${bucketOf(unusedDeps + devDependencies)}`),
            severity: `info`,
            // The sample rather than the full list, and the goal tells the agent to re-run knip for the rest: this
            // measurement is hours old, and sending a turn at a file that has already been deleted wastes it.
            why:
                `knip reports ${plural(files, `unreferenced file`)}, ${exports + types} unused exports and ` +
                `${unusedDeps + devDependencies} unused dependencies in ${repoLabel(context.repo)}` +
                `${sample.length === 0 ? `` : `, among them ${sample.join(`, `)}`}.`,
        };
    },
    diagnosis: `Code nothing reaches still has to be read, type-checked and kept compiling by everyone who works nearby.`,
    goal:
        `Re-run knip yourself first — this measurement is hours old and the tree has moved. Then check each finding against how the ` +
        `file is actually used: knip is confidently wrong about anything reachable from OUTSIDE the repository, which means a package's ` +
        `public entry points, files a bundler or framework loads by convention, and types consumed only by a downstream package. Delete ` +
        `what is genuinely unreachable. Leave the false positives and list them in one line each, so the next run's reader knows they ` +
        `were considered rather than missed.`,
    done: `Done when knip reports fewer findings, the repository's type-check and tests pass, and nothing you deleted is reachable from another package.`,
};

/* DUPLICATION. Report-stance, and it is the clearest case for why that stance exists at all. Most duplication
 * should not be removed: generated files, tests that repeat on purpose, and two things that merely look alike
 * today but answer to different owners tomorrow. Deciding which copies genuinely have to change together is a
 * design judgement, and an agent that "collapses duplication" unattended produces exactly the abstraction that
 * gets deleted a year later. */
const DUPLICATION_FLOOR = 5;

const duplication: Chore = {
    id: `duplication`,
    title: `Find duplication worth collapsing`,
    icon: `clone`,
    description: `Copy-paste that has grown past a fifth of a percent of the tree. Reports only — extracting is a design call.`,
    stance: `report`,
    needs: [`jscpd`],
    cadenceMs: 30 * DAY_MS,
    automation: {
        cron: `0 3 * * 1`,
        // Gated on the percentage rather than "any clone at all", which every real repository has: below this the
        // report is noise that would wake an agent every week to say nothing actionable.
        guard:
            `pnpm dlx jscpd --reporters json --output ${JSCPD_DIR} --min-lines 12 --threshold 100 . >/dev/null 2>&1; ` +
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
            // A whole percentage point is the smallest move worth calling news; the biggest clones' identities
            // carry the rest, so a new large clone appearing is an event even at a flat percentage.
            digest: digestOf(`pct:${Math.round(percentage)}`, ...top.map((clone) => `${clone.first}|${clone.second}`).toSorted()),
            severity: `info`,
            why:
                `jscpd reports ${percentage.toFixed(1)}% duplication across ${plural(clones, `clone`)} in ${repoLabel(context.repo)}; ` +
                `the largest are ${top.map((clone) => `${clone.first} ↔ ${clone.second} (${clone.lines} lines)`).join(`; `)}.`,
        };
    },
    diagnosis: `Duplication only costs anything when the copies have to change together — and only some of it does.`,
    goal:
        `Report the clones where the copies genuinely have to change together. For each: cite both file:line ranges, say what the shared ` +
        `concept actually is, and name where the extraction would live. Then say explicitly which of the reported clones you are NOT ` +
        `recommending against — generated files, deliberately repetitive tests, and lookalikes owned by different subsystems — so the ` +
        `next reader knows the list was triaged rather than truncated.`,
    done: `Done when every clone in the report has either a named extraction or a one-line reason it should stay.`,
};

/* DOCUMENTATION. The evidence is a package with no architecture document, which sounds like a coverage statistic
 * and would be one if the rail read it directly. It does not: the digest is the SET of undocumented package
 * directories, so a long-standing backlog goes quiet after it is seen once, and a package appearing that nothing
 * explains is an event that speaks. That is the whole difference between this being useful and being a nag. */
const documentation: Chore = {
    id: `documentation-refresh`,
    title: `Document what nothing explains`,
    icon: `file-edit`,
    description: `Packages in this repository with no architecture document — new ones first.`,
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
                `docs/architecture document: ${undocumented.map((entry) => entry.dir).join(`, `)}.`,
        };
    },
    diagnosis: `A package nobody can read the shape of gets worked in by guesswork, and the guesses accumulate.`,
    goal:
        `Follow this workspace's own documentation conventions — read them first, they are not optional and they are not generic. For ` +
        `each undocumented package, read the package before you write a word about it, and produce the document its conventions call ` +
        `for: what the package is FOR, how it fits the system, and which files matter. Explain at the module level. Never describe code ` +
        `line by line, and never document a package you did not read.`,
    done: `Done when every package you named has a document that a newcomer could use to find the file they need, and no other file changed.`,
};

/* COMPLEXITY. The one chore whose evidence comes from the resident index rather than a subprocess, and the one
 * most at risk of being a ranking laundered into a to-do list — there is ALWAYS a top of a hotspot ranking, and
 * "your worst file" is not a finding. So it does not report the ranking. It reports the two shapes within it that
 * are genuinely arguable:
 *
 *   volatile AND load-bearing   a hotspot that is also a key module: every edit ripples outward.
 *   out of proportion           branching three times the median of its own ranking: tangled, not merely busy.
 *
 * Both are relative to the same list the user is reading, so nothing here needs tuning per repository or per
 * language, and a healthy repo produces an empty set rather than a top five. */
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
    description: `Files that both churn and carry the repository — where edits are slow and ripple outward.`,
    stance: `act`,
    needs: [],
    cadenceMs: 30 * DAY_MS,
    assess: (context) => {
        // A half-built index ranks whatever it has finished reading, which is not the repository. Better to say
        // nothing than to send a turn at the wrong file.
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
            detail: found.map((hotspot) => `${hotspot.path} — ${hotspot.commits} commits, ${reason(hotspot.path, hotspot.complexity)}`),
            digest: digestOf(...found.map((hotspot) => hotspot.path).toSorted()),
            severity: `info`,
            why:
                `${plural(found.length, `file`)} in ${repoLabel(context.repo)} are both change magnets and structurally tangled: ` +
                `${found.map((hotspot) => `${hotspot.path} (${hotspot.commits} commits, ${hotspot.complexity} branch points)`).join(`; `)}.`,
        };
    },
    diagnosis: `A file that changes constantly and branches heavily makes every edit near it slow and easy to get wrong.`,
    goal:
        `Take ONE file — the worst of them — and no more. Read it first. If the rest of the repository imports it, separate the stable ` +
        `contract from the churn: a narrow surface for importers, the volatile implementation private behind it. If it is simply ` +
        `tangled, flatten it where it stands — edge cases as early returns, compound conditions behind named predicates, long chains as ` +
        `lookups — and extract a unit only if a cohesive one falls out. Behaviour stays identical, and no re-export shims are left behind.`,
    done: `Done when \`iq hotspots\` reports materially fewer branch points for that file, the repository's checks pass, and no importer changed meaning.`,
};

/* RUNTIME. A static table, and it is honest about being one: there is no network call here, so the dates below
 * are a fact about the day this file was last edited rather than a live feed. That is the right trade for a
 * signal that moves twice a year and must work on a box with no outbound access — but it does mean this table is
 * maintenance in its own right, and a major missing from it reads as "not end-of-life", which is the safe way to
 * be wrong. Source: nodejs/Release. */
const NODE_EOL: Readonly<Record<number, string>> = {
    16: `2023-09-11`,
    18: `2025-04-30`,
    20: `2026-04-30`,
    22: `2027-04-30`,
    24: `2028-04-30`,
};
// How far ahead of an end-of-life date the chore starts speaking. A quarter, because moving a runtime is planned
// work — telling someone the day security patches stop is telling them too late to do anything but scramble.
const EOL_HORIZON_MS = 90 * DAY_MS;

const runtime: Chore = {
    id: `runtime-eol`,
    title: `Move off an end-of-life runtime`,
    icon: `bolt`,
    description: `Whether the Node this sandbox runs still receives security patches.`,
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
        // Which packages would have to be argued with, so the finding names the work rather than only the fact.
        const pinned = context.signals.packages.filter((entry) => entry.engines?.[`node`] !== undefined);
        return {
            headline: past ? `Node ${major} stopped receiving security patches ${days} days ago` : `Node ${major} reaches end of life in ${days} days`,
            detail: [
                `running · ${context.node}`,
                `end of life · ${eol}`,
                ...pinned.map((entry) => `pinned · ${entry.name} requires node ${entry.engines?.[`node`] ?? ``}`),
            ],
            // The state, not the date: a countdown would mint a new digest every single day and badge forever.
            digest: digestOf(`node:${major}`, past ? `eol` : `approaching`),
            severity: past ? `warning` : `info`,
            why:
                `This sandbox runs ${context.node}, and Node ${major} ${past ? `reached end of life on ${eol}` : `reaches end of life on ${eol}`} — ` +
                `${plural(pinned.length, `package`)} in ${repoLabel(context.repo)} pin a node engine range.`,
        };
    },
    diagnosis: `An unsupported runtime stops receiving security patches, so every advisory against it stays open permanently.`,
    goal:
        `Establish what actually pins this runtime: the image's own base, the workspace's useNodeVersion, and each package's engines ` +
        `range. Propose the smallest move to a supported LTS — which of those pins have to change, in what order, and what is likely to ` +
        `break at that boundary. Make the pin changes that are mechanical; do NOT attempt the image rebuild itself.`,
    done: `Done when the pins name a supported release, the repository's type-check and tests pass on it, and anything needing a rebuild is named as such.`,
};

/* LIBRARIES. The one chore here with evidence for a question that usually gets asked as a vibe ("should we be
 * using a library for this?"). Two libraries that solve the same problem in one tree is a fact, not an opinion:
 * somebody added the second one without removing the first, both are now in the bundle, and new code picks
 * whichever the neighbouring file used. The table below is deliberately short and only names categories where
 * having two is genuinely a mistake — not, say, two test runners, which is an ordinary migration. */
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
    description: `Two dependencies solving the same problem — both shipped, both maintained, one picked at random.`,
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
        `For each overlapping pair, find out which one is actually load-bearing — how many call sites each has, whether one is a ` +
        `transitive dependency nobody chose, and whether either is unmaintained. Recommend the one to keep and estimate the migration ` +
        `honestly, including the call sites where the two libraries genuinely differ in behaviour. Where the overlap is deliberate or ` +
        `the second is only transitive, say so and close the question.`,
    done: `Done when every overlapping pair has a recommendation with a call-site count behind it, or a reason the overlap is fine.`,
};

/* THE SURVEYS. Three chores with no measurement at all, and they are here because the absence of a measurement is
 * not the absence of value — these are the reviews a codebase silently rots without, and none of them can be
 * detected by a tool. Their trigger is the calendar, and the ledger is what makes that trigger honest: a survey is
 * due because it has not been done in a quarter, which is a claim the panel can show and the reader can check.
 *
 * All three are report-stance. A survey that starts editing is the most surprising thing this surface could do,
 * and none of them has a specific enough finding to justify a diff. */
const survey = (
    id: string,
    title: string,
    icon: string,
    description: string,
    diagnosis: string,
    goal: string,
    done: string,
    cadenceDays: number,
): Chore => ({
    id,
    title,
    icon,
    description,
    stance: `report`,
    needs: [],
    cadenceMs: cadenceDays * DAY_MS,
    survey: true,
    // A survey's evidence is that time has passed, so the digest is the PERIOD it is due for: one badge per
    // quarter, and a run inside that quarter settles it until the next one begins.
    assess: (context) => ({
        headline: `Not surveyed in ${cadenceDays} days`,
        detail: [`Cadence · every ${cadenceDays} days`],
        digest: digestOf(id, `period:${Math.floor(context.nowMs / (cadenceDays * DAY_MS))}`),
        severity: `info`,
        why: `This is a periodic review of ${repoLabel(context.repo)}, run every ${cadenceDays} days; nothing measured it — it is due because it has been that long.`,
    }),
    diagnosis,
    goal,
    done,
});

const patterns = survey(
    `standardize-patterns`,
    `Standardize the cross-cutting patterns`,
    `sitemap`,
    `Error handling, validation, logging, configuration, retries, pagination — the things every file does slightly differently.`,
    `Cross-cutting concerns drift one file at a time, and the cost only shows up when someone has to work across several of them.`,
    `Pick the cross-cutting concerns this repository actually has — error handling, input validation, logging, configuration, retries, ` +
        `pagination, serialization — and for each, survey how it is done. Name the dominant pattern, the outliers, and which of the ` +
        `outliers are deliberate. Recommend ONE convention per concern with a file to point at as the reference implementation, and ` +
        `estimate the size of the conversion. Do not convert anything.`,
    `Done when each concern has a named convention, a reference file, and a count of the sites that diverge from it.`,
    90,
);

const deprecated = survey(
    `deprecated-apis`,
    `Audit deprecated APIs`,
    `exclamation-triangle`,
    `Language, runtime and framework APIs this code still uses that their own maintainers have moved on from.`,
    `A deprecated API works right up until the upgrade that removes it, and then it is an emergency during someone else's migration.`,
    `Survey what this repository uses that its own dependencies have deprecated: read the framework and runtime versions in use, check ` +
        `their deprecation notices, and search for the call sites. Include the repository's OWN deprecations — anything its code marks ` +
        `as deprecated and still calls. Rank by when each one actually breaks, not by how many call sites it has, and name the ` +
        `replacement for each. Change nothing.`,
    `Done when every deprecation has call sites cited, a replacement named, and the release it is expected to break in.`,
    90,
);

const documentationDrift = survey(
    `documentation-drift`,
    `Re-read the documentation against the code`,
    `file`,
    `Whether what the documents claim is still what the code does — the drift no tool can measure.`,
    `Documentation is trusted in proportion to how recently it was true, and a document that is quietly wrong is worse than a missing one.`,
    `Read this repository's architecture documents against the code they describe. Report every claim that is no longer true, citing the ` +
        `document line and the file that contradicts it. Prioritise the claims someone would ACT on — where a subsystem lives, what owns ` +
        `what, which file to change — over prose that has merely aged. Do not rewrite the documents; produce the list of what is wrong.`,
    `Done when every architecture document has been read and every false claim is listed with both sides cited.`,
    90,
);

/* THE BOOK'S ORDER, which is the panel's reading order and therefore a product decision rather than whatever
 * order these were written in. It narrows from "this is a risk you are carrying right now" to "this is worth
 * thinking about this quarter":
 *   carrying   security, runtime — someone else decides when these become urgent
 *   accruing   dependencies, dead code, complexity — cheap now, expensive later, and always getting later
 *   drifting   documentation, duplication, libraries — the shape of the thing is diverging from the idea of it
 *   surveying  the three periodic reads, which have no urgency by construction */
export const CHORES: readonly Chore[] = [
    security,
    runtime,
    dependencies,
    deadCode,
    complexity,
    documentation,
    duplication,
    libraries,
    patterns,
    deprecated,
    documentationDrift,
];

export const choreById = (id: string): Chore | undefined => CHORES.find((chore) => chore.id === id);

// The prompt for one chore against one finding. Built here rather than in the view because the panel, the badge's
// tooltip and the automation that runs unattended must all be describing the same turn.
/* THE SCHEDULED TURN, for a chore woken by its automation rather than started from the panel. Same four parts and
 * the same invariants — a chore asks for the same work whoever started it — with the guard's own report standing
 * in for the finding, because at 3am there is no verdict to quote and no reader to have checked it first.
 *
 * Workspace-wide rather than per repository: an automation's guard runs at the workspace root on the sandbox's
 * clock, and it has no repo argument to be scoped by. */
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
        why: `${finding.why} ${TRIAGE_NOTE}`,
        diagnosis: chore.diagnosis,
        goal: chore.goal,
        invariants: chore.stance === `act` ? CHORE_INVARIANTS : REPORT_INVARIANTS,
        done: chore.done,
    });
