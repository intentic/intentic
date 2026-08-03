import type { Advisory, ChoreSignals, OutdatedPackage, ProbeId, ProbeResult } from "../schemas.js";
import { bucketOf, digestOf } from "./digest.js";
import { CHORE_INVARIANTS, composeAsk, REPORT_INVARIANTS, TRIAGE_NOTE } from "./prompt.js";
import { componentStem, frameworksOf, idiomRule, normalizePath, UI_FRAMEWORKS, usesTailwind } from "./stack.js";

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

/* WHAT KIND OF CLAIM A CHORE MAKES ON SOMEONE'S ATTENTION. Four of them, ordered from "this is a risk you are
 * carrying right now" to "this is worth thinking about this quarter" — see CHORE_KINDS at the foot of this file,
 * which carries the argument and the words the panel groups under. */
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
    /* WHICH OF THE FOUR KINDS OF CLAIM THIS IS (CHORE_KINDS, at the foot of this file). It decides the book's
     * order and the panel's grouping, and it is a FIELD rather than a comment above the array for exactly that
     * reason: the reading order is the one editorial claim this surface makes, and a claim spelled as a comment
     * beside a hand-maintained list is one nobody can check and the compiler cannot keep. */
    readonly kind: ChoreKind;
    /* THE RULE, in words — what has to be true for this chore to be due, stated so a reader can check it against
     * the evidence below it and disagree.
     *
     * This is not decoration. A row that says "4 majors waiting" and nothing else is asking to be taken on
     * trust; the same row saying "shown because: a dependency is a major version behind" is a claim someone can
     * argue with, and arguing with it is how the book gets better. It rides into the prompt too, so the agent is
     * told the rule it was woken by rather than left to infer it from the numbers.
     *
     * Kept as prose next to the code that implements it, which means it can drift from it — the tests below
     * cannot check English. The rule for writing one: say the THRESHOLD, not the subject. "Duplication is high"
     * is a topic; "more than 5% of the tree is duplicated" is a criterion. */
    readonly criterion: string;
    /* WHETHER THIS IS A QUESTION WORTH ASKING OF THIS REPOSITORY AT ALL — returns undefined when it is, and a
     * plain-language reason when it is not ("this repository ships no Dockerfile").
     *
     * Distinct from `assess`, and the distinction is the whole point: `assess` asks whether the answer is yes,
     * this asks whether the question makes sense. "Re-read the documentation against the code" in a repository
     * with no documentation is not a chore that is currently clear — it is one that will never apply here, and
     * showing it as clear says we checked something we cannot check. A chore that does not apply is dropped from
     * the panel entirely; only a footer records that it was considered.
     *
     * Reads `signals` rather than probes on purpose: applicability is about what the repository IS, which is a
     * fact the daemon holds without measuring anything. If a gate needed a probe it would be describing the
     * answer rather than the question. */
    readonly applies?: (signals: ChoreSignals) => string | undefined;
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

// The same repository, named for a surface that has a 16rem column or a chip to say it in. `repoLabel` is prose
// and reads as prose inside a sentence ("update dependencies in the workspace root repository"); a rail row wants
// the name on its own, and "the workspace root repository" truncates to "the workspace root reposi…" there.
export const repoName = (repo: string): string => (repo === `root` || repo === `` ? `workspace root` : repo);

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
    kind: `carrying`,
    criterion: `pnpm audit reports an advisory of high or critical severity against the resolved tree.`,
    applies: (signals) => (signals.shape.lockfile ? undefined : `there is no lockfile here, so nothing resolves to a tree that could be audited`),
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
    kind: `accruing`,
    criterion: `A dependency is a major version behind, or more than 20 are behind by any amount.`,
    applies: (signals) => (signals.shape.packageManifest ? undefined : `this repository has no package.json, so there is no npm dependency tree to be behind`),
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
    kind: `accruing`,
    criterion: `knip reports at least one unreferenced file, export or dependency.`,
    applies: (signals) => (signals.shape.packageManifest ? undefined : `this repository is not a Node project, and knip only reads those`),
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
            headline: `${plural(files, `unreferenced file`)}, ${plural(exports + types, `unused export`)}, ${plural(unusedDeps + devDependencies, `unused dependency`, `unused dependencies`)}`,
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
    kind: `drifting`,
    criterion: `jscpd reports more than 5% of the scanned tree duplicated.`,
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
    kind: `drifting`,
    criterion: `A workspace package has no docs/architecture document.`,
    applies: (signals) => (signals.packages.length > 0 ? undefined : `this repository is not a workspace, so it has no packages to document one by one`),
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
    kind: `accruing`,
    criterion: `A file in the hotspot ranking is also a key module, or its branching is three times the median of that ranking.`,
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
    kind: `carrying`,
    criterion: `The Node release this sandbox runs is past its end-of-life date, or within 90 days of it.`,
    applies: (signals) => (signals.shape.packageManifest ? undefined : `this repository is not a Node project, so the sandbox's runtime is not its concern`),
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
    kind: `drifting`,
    criterion: `Two or more installed dependencies do the same job.`,
    applies: (signals) => (signals.packages.length > 0 ? undefined : `this repository is not a workspace, so there are no package manifests to compare`),
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

/* ---- THE FRONT-END CHORES -------------------------------------------------------------------------------------
 *
 * Four chores that only exist where a UI framework does, kept together because they share one gate and one
 * probe — and split across the reading order in CHORES, since where a row belongs is decided by what KIND of
 * finding it is, not by which file paragraph it was written in.
 *
 * They gate on `shape.deps` rather than on `signals.packages`, and that is not interchangeable. `packages` is
 * populated from pnpm-workspace.yaml, so it is EMPTY for a repository that is not a monorepo — which is what a
 * Vite app, a Next app and an Angular CLI project all are. A framework gate reading it would be permanently dark
 * in the overwhelming majority of the repositories these four were written for, and dark silently: the chores
 * would not appear, the footer would say the repository has no packages, and nothing would look broken.
 *
 * All four also say something the rest of the book does not have to. A component, a class name and a bundle chunk
 * are things nobody sees the whole of — you read one component at a time, and the tenth copy of a button looks
 * exactly like the first nine did. That is the same argument the whole surface rests on, just further from the
 * places a compiler will ever help. */

// How many rows of evidence a UI finding lists before it is a wall rather than a list. The standing count still
// leads the headline; this only bounds what is enumerated underneath it.
const DETAIL_LIMIT = 8;

const FRAMEWORK_LABELS = UI_FRAMEWORKS.map((framework) => framework.label).join(`, `);

// One gate, one sentence, four chores. Built from the table so that a framework added to stack.ts cannot leave a
// stale list of names behind in an error message nobody re-reads.
const needsFramework = (signals: ChoreSignals): string | undefined =>
    frameworksOf(signals.shape.deps).length > 0 ? undefined : `this repository declares no ${FRAMEWORK_LABELS} dependency, so it has no components`;

const bytesLabel = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} kB`);

/* BUNDLE. What a browser downloads before anything appears, which is the fact about a front-end that is furthest
 * from anything visible in an editor: every dependency looks the same size in an import statement.
 *
 * The criterion is a SHARE, and that is deliberate — it is the second exception to the book's leader-relative
 * rule, and it earns the same defence duplication's 5% does. A byte threshold would need a different value for a
 * marketing page and an IDE, would be argued about forever, and would be wrong the moment either one grew. "One
 * chunk is more than half of everything you ship" needs no calibration: it says the build is not split, which is
 * true or false at any size. A well-split app has its largest chunk well under this whatever it weighs, and a
 * small app that genuinely is one chunk trips it and is right to — that IS its entire download.
 *
 * Report-stance. Where the split boundaries go is a routing and product decision, and an agent that lazily
 * imported things unattended at three in the morning would be making it. */
const BUNDLE_SHARE_FLOOR = 50;
// Below this there is no ranking to be an outlier in — two files cannot tell you anything about how a build is
// divided, and the largest of them is over half by arithmetic rather than by fault.
const BUNDLE_MIN_ASSETS = 3;

/* An asset's name with its content hash taken out — `assets/vendor-DlAUqK2U.js` becomes `assets/vendor.js`.
 *
 * Without this the digest changes on every single build, because a content hash changing is the entire point of a
 * content hash. The chore would badge after every `pnpm build` while reporting nothing new, which is precisely
 * the lit-every-day failure the digest exists to prevent.
 *
 * Eight or more characters containing a digit, immediately before the final extension: long enough to leave
 * `vendor-react.js` and `.min.js` alone, specific enough to catch Vite's `-DlAUqK2U` and webpack's `.9f2a1b0c`. */
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
        // By GZIP, not by raw bytes. What is on disk is not what crosses the wire, and a large but highly
        // compressible asset — a source map comment, a big JSON blob — is not the download this is about.
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
            detail: ranked.slice(0, DETAIL_LIMIT).map((asset) => `${bytesLabel(asset.gzip)} gzipped · ${asset.path} (${bytesLabel(asset.bytes)} on disk)`),
            // The bucketed total and the hash-stripped identities of the biggest chunks. A rebuild of the same
            // code is silent; a new heavy chunk appearing, or the whole thing doubling, is not.
            digest: digestOf(`total:${bucketOf(totalGzip)}`, ...ranked.slice(0, 5).map((asset) => stableAsset(asset.path)).toSorted()),
            // Not a risk being carried, however large. `warning` is reserved for something with a clock on it.
            severity: `info`,
            why:
                `The build output in ${dir}/ of ${repoLabel(context.repo)} is ${bytesLabel(totalGzip)} gzipped across ` +
                `${plural(assets.length, `asset`)}, and ${largest.path} alone is ${bytesLabel(largest.gzip)} of it — ${Math.round(share)}%. ` +
                `The next largest are ${ranked.slice(1, 4).map((asset) => `${asset.path} (${bytesLabel(asset.gzip)})`).join(`, `)}. ` +
                `This is the last build someone ran, read off disk; nothing rebuilt it to measure.`,
        };
    },
    diagnosis: `Everything in the first chunk is downloaded and parsed before anything renders, whether or not the visitor needed it.`,
    goal:
        `Find out what is actually IN the dominant chunk before proposing anything — the repository's own bundler can report this, and a ` +
        `recommendation made without it is guesswork. Then report the split worth making: which routes or features could load on demand, ` +
        `which dependencies are pulled in wholesale for one function, and which are only used behind an interaction nobody has yet had. ` +
        `Name the boundary for each and estimate what it saves. Where the chunk is genuinely all first-paint code, say so and close it.`,
    done: `Done when every recommendation names a specific import boundary and the bytes it would move out of the first download.`,
};

/* FRAMEWORK IDIOMS. A migration nobody finished, which is the most ordinary state for a front-end of any age: the
 * new way arrived, the new files use it, and the old files keep working — so nothing ever forces the rest.
 *
 * The digest is the one place this chore differs in shape from its neighbours, and it has to. Digesting the file
 * identities, the way the documentation chore does, would re-badge every time anyone touched any of two hundred
 * files, because a migration in progress is a set that changes constantly. So it digests the BUCKETED COUNT per
 * idiom instead: a kind of legacy code appearing where there was none speaks, real progress through a bucket
 * speaks, and one more file drifting in or out of a set of two hundred does not. */
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
        /* Two rules are dropped rather than shown, and the second is the one that would have made this chore
         * embarrassing.
         *
         * AN IDIOM THIS BUILD HAS NEVER HEARD OF. The daemon composes the sweep from its own copy of the table, so
         * a sandbox image ahead of the browser can report a rule that has no label or replacement here — and a row
         * saying "42 files use react-foo" with no idea what to do about them is worse than no row.
         *
         * AN IDIOM BELONGING TO A FRAMEWORK THIS REPOSITORY DOES NOT USE. A probe's command is a fixed string, so
         * every rule in the table is swept in every repository, and an Angular pattern gets its chance in a Vue
         * codebase: `RouterModule.forRoot` inside a comment, a `*ngIf` in an example string, and — the case that
         * caught this — the book's own rule table quoting its own patterns back at it. What the repository
         * DECLARES is the arbiter, the same `deps` the gate above reads. */
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
                `A sample of the files: ${ranked.flatMap((entry) => entry.files.slice(0, 3)).slice(0, DETAIL_LIMIT).join(`, `)}.`,
        };
    },
    diagnosis: `A retired idiom keeps working until the major release that drops it, and then it is an emergency inside somebody else's upgrade.`,
    goal:
        `Take ONE idiom, the one with the most files, and no more. Convert the files where the conversion is mechanical and the behaviour ` +
        `is provably identical. Stop at the first file that needs a design decision — a class component with genuine error-boundary ` +
        `semantics, an NgModule that something outside the repository imports — leave it, and say what it would take. Do not convert an ` +
        `idiom the repository has deliberately kept: if the newest code uses it too, that is a choice, and reporting it as one is the ` +
        `useful answer.`,
    done: `Done when a re-scan reports fewer files on that idiom, the repository's type-check and tests pass, and every file you skipped has a one-line reason.`,
};

/* COMPONENTS. Two components that are the same component, which is the `library-overlap` finding turned inward:
 * somebody needed a button, did not find the one that existed, and wrote a second one. It is the most ordinary
 * kind of duplication in a front-end and the one no tool complains about, because both files are perfectly good
 * code and neither knows the other exists.
 *
 * TWO KINDS OF EVIDENCE, and they catch opposite failures. A NAME FAMILY catches components that were written
 * separately and never shared a line — `BaseButton.vue` and `ButtonV2.tsx` reduce to the same stem, and no clone
 * detector will ever connect them. A CLONE PAIR catches the reverse: two components with unrelated names doing
 * the same work, which is what jscpd is actually good at, filtered to the pairs where both sides are components
 * so it is a finding about the UI rather than a slice of the repo-wide duplication chore.
 *
 * It needs jscpd rather than reading it if present. Half a measurement would let the row claim it had looked for
 * shared logic in a repository where that sweep has never run — the exact "measured and found nothing" lie the
 * `unavailable` state exists to make impossible. jscpd is already running weekly for the duplication chore in any
 * Node repository, so the honest choice is also the free one. */
const componentOverlap: Chore = {
    id: `component-overlap`,
    title: `Settle on one component per job`,
    icon: `copy`,
    description: `Components built twice — the same name in two places, or the same logic under two names.`,
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
        // Only the clones with a component on BOTH sides. A component that shares a block with a utility module
        // is the duplication chore's finding, not this one, and reporting it here would be two rows lighting for
        // one fact.
        const inventory = new Set(ui.scan.components.map(normalizePath));
        const pairs = jscpd.duplication.top.filter((clone) => inventory.has(normalizePath(clone.first)) && inventory.has(normalizePath(clone.second)));
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
            // Identities on both halves: every component that joins or leaves a family, and every clone pair that
            // appears, is genuinely a new fact rather than drift in a number.
            digest: digestOf(
                ...families.map((family) => `${family.stem}:${family.paths.join(`+`)}`).toSorted(),
                ...pairs.map((clone) => `${normalizePath(clone.first)}|${normalizePath(clone.second)}`).toSorted(),
            ),
            severity: `info`,
            why:
                `${repoLabel(context.repo)} has ${parts.join(` and `)}, out of ${plural(ui.scan.components.length, `component file`)} scanned. ` +
                `${families.length === 0 ? `` : `The names: ${families.slice(0, DETAIL_LIMIT).map((family) => `${family.stem} (${family.paths.join(`, `)})`).join(`; `)}. `}` +
                `${pairs.length === 0 ? `` : `The clones: ${pairs.map((clone) => `${normalizePath(clone.first)} ↔ ${normalizePath(clone.second)}, ${clone.lines} lines`).join(`; `)}.`}`,
        };
    },
    diagnosis: `A component built twice is maintained once — whichever copy the next person happens to open is the one that gets the fix.`,
    goal:
        `Read every file in each group before saying anything about it; a shared name is a reason to look, not a finding on its own. For ` +
        `each group, say whether these genuinely do the same job, and if they do, name the one to keep and count the call sites that would ` +
        `have to move. Where the answer is that the same LOGIC is duplicated rather than the whole component — the same fetch and loading ` +
        `state, the same form validation, the same list virtualization written twice — say so, and name the hook or composable it should ` +
        `become and where it would live. Where two components share a name and nothing else, say that too and close it: a false family is ` +
        `worth one line, and the next reader needs to know it was considered.`,
    done: `Done when every group has either a component to keep with a call-site count, a shared unit to extract with a home, or a reason it is fine.`,
};

/* TAILWIND. A design system exists to make a decision once; an arbitrary value is that decision being made again,
 * inline, by whoever was in the file. What makes this measurable rather than a matter of taste is that Tailwind
 * spells the bypass out loud — `bg-[#3b82f6]` is the palette being stepped around, in the markup, in a form no
 * reviewer can miss and no linter mentions.
 *
 * Deliberately NOT every arbitrary value. `grid-cols-[1fr_auto]` is the feature working as intended and there is
 * no token it should have been; matching those would make this an objection to Tailwind rather than a finding
 * about this repository. Only colours and pixel sizes, which are the two things the theme definitely already has
 * an answer for. */
const tailwindBypass: Chore = {
    id: `tailwind-arbitrary-values`,
    title: `Put hard-coded styles back on the scale`,
    icon: `palette`,
    description: `Colours and sizes written inline in the markup, around the theme that already defines them.`,
    kind: `drifting`,
    criterion: `A Tailwind class hard-codes a colour or a pixel size instead of using the theme's scale.`,
    applies: (signals) => (usesTailwind(signals.shape.deps) ? undefined : `this repository does not use Tailwind, so there is no theme scale to bypass`),
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
            // The worst files by identity — a new file arriving at the top of this list is the event — with the
            // spread and the total riding along bucketed, because both drift by one every time anyone writes
            // markup and neither is worth interrupting somebody about.
            digest: digestOf(...worst.map((entry) => entry.path).toSorted(), `files:${bucketOf(bypasses.length)}`, `total:${bucketOf(total)}`),
            severity: `info`,
            why:
                `${repoLabel(context.repo)} has ${plural(total, `Tailwind class`, `Tailwind classes`)} hard-coding a colour or a pixel size ` +
                `across ${plural(bypasses.length, `file`)}; the heaviest are ` +
                `${worst.slice(0, 5).map((entry) => `${entry.path} (${entry.count})`).join(`, `)}.`,
        };
    },
    diagnosis: `Every inline colour is a place the theme cannot reach — a palette change lands everywhere except the files that opted out of it.`,
    goal:
        `Read the theme first — the Tailwind config, or the CSS that defines the tokens — so you know what the scale actually offers. Then ` +
        `replace the values that have a token: an exact palette match, a spacing step, a type size. Where a value is CLOSE to a token but ` +
        `not equal, do not round it silently; that is a visual change wearing a refactor's clothes. List those separately with both values ` +
        `and let the owner decide. Where a value has no token and should — a brand colour used in nine places — say that the theme is ` +
        `missing an entry rather than editing nine files.`,
    done: `Done when a re-scan reports fewer hard-coded values, nothing renders differently, and every value you left has a one-line reason.`,
};

/* THE SURVEYS. Chores with no measurement at all, and they are here because the absence of a measurement is not
 * the absence of value — these are the reviews a codebase silently rots without, and none of them can be detected
 * by a tool. Their trigger is the calendar, and the ledger is what makes that trigger honest: a survey is due
 * because it has not been done in a quarter, which is a claim the panel can show and the reader can check.
 *
 * All of them are report-stance. A survey that starts editing is the most surprising thing this surface could do,
 * and none of them has a specific enough finding to justify a diff.
 *
 * A SURVEY NEEDS ITS `applies` GATE MORE THAN A MEASURED CHORE DOES, not less, and this is the trap the shape of
 * the thing sets. A measured chore is gated by its own evidence for free: no undocumented packages, no finding,
 * no row. A survey has no evidence to be absent — "90 days have passed" is true of every repository in the
 * world — so without a gate it fires everywhere, forever, including in the repositories where its subject does
 * not exist. "Re-read the documentation against the code" in a repository with no documentation is the exact
 * failure, and it is not a hypothetical: it is what this helper did before the gate existed.
 *
 * An options object rather than the eight positional arguments this grew into: `id, title, icon, description,
 * diagnosis, goal, done, 90` reads as nothing at all at the call site, and the gate would have made it nine. */
interface SurveySpec {
    readonly id: string;
    readonly title: string;
    readonly icon: string;
    readonly description: string;
    readonly diagnosis: string;
    readonly goal: string;
    readonly done: string;
    readonly cadenceDays: number;
    // What must exist in the repository for this review to have a subject. Required, not optional, precisely
    // because forgetting it is the failure mode above — a survey that genuinely applies everywhere still has to
    // say so out loud, with `() => undefined`.
    readonly applies: (signals: ChoreSignals) => string | undefined;
}

const survey = ({ id, title, icon, description, diagnosis, goal, done, cadenceDays, applies }: SurveySpec): Chore => ({
    id,
    title,
    icon,
    description,
    // Not a parameter of SurveySpec, and it never will be: a survey has no measurement, so "due because it has
    // been that long" IS the surveying kind. The two are the same claim spelled twice, and the test below holds
    // them to it in both directions.
    kind: `surveying`,
    criterion: `${cadenceDays} days have passed since this review was last run.`,
    applies,
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

// Below this a repository is too small for cross-cutting patterns to have diverged from each other: there is one
// way things are done because there is barely more than one place doing them. Counted in INDEXED files, so a
// scaffold that is mostly config and lockfiles does not pass it by accident.
const PATTERNS_FLOOR = 25;

const patterns = survey({
    id: `standardize-patterns`,
    title: `Standardize the cross-cutting patterns`,
    icon: `sitemap`,
    description: `Error handling, validation, logging, configuration, retries, pagination — the things every file does slightly differently.`,
    diagnosis: `Cross-cutting concerns drift one file at a time, and the cost only shows up when someone has to work across several of them.`,
    goal:
        `Pick the cross-cutting concerns this repository actually has — error handling, input validation, logging, configuration, retries, ` +
        `pagination, serialization — and for each, survey how it is done. Name the dominant pattern, the outliers, and which of the ` +
        `outliers are deliberate. Recommend ONE convention per concern with a file to point at as the reference implementation, and ` +
        `estimate the size of the conversion. Do not convert anything.`,
    done: `Done when each concern has a named convention, a reference file, and a count of the sites that diverge from it.`,
    cadenceDays: 90,
    applies: (signals) =>
        signals.totals.files >= PATTERNS_FLOOR
            ? undefined
            : `this repository has ${signals.totals.files} indexed files — too few for cross-cutting patterns to have diverged`,
});

const deprecated = survey({
    id: `deprecated-apis`,
    title: `Audit deprecated APIs`,
    icon: `exclamation-triangle`,
    description: `Language, runtime and framework APIs this code still uses that their own maintainers have moved on from.`,
    diagnosis: `A deprecated API works right up until the upgrade that removes it, and then it is an emergency during someone else's migration.`,
    goal:
        `Survey what this repository uses that its own dependencies have deprecated: read the framework and runtime versions in use, check ` +
        `their deprecation notices, and search for the call sites. Include the repository's OWN deprecations — anything its code marks ` +
        `as deprecated and still calls. Rank by when each one actually breaks, not by how many call sites it has, and name the ` +
        `replacement for each. Change nothing.`,
    done: `Done when every deprecation has call sites cited, a replacement named, and the release it is expected to break in.`,
    cadenceDays: 90,
    applies: (signals) => (signals.shape.packageManifest ? undefined : `this repository declares no dependencies whose deprecations could be read`),
});

/* THE CHORE THAT NAMED THE PROBLEM. Gated on documents actually EXISTING, which is the whole reason `applies`
 * exists: without it this survey fires on its cadence in every repository, including the ones with nothing to
 * re-read, and the first thing an owner of a fresh workspace sees is an offer to re-read documentation they have
 * never written. That is not a chore being wrong about a threshold — it is the surface admitting it never looked.
 *
 * Note which fact it gates on: the DOCUMENTS, not the directory. An empty `docs/architecture/` is a directory
 * somebody made and never filled, and a gate on the directory would put the chore back exactly where it started. */
const documentationDrift = survey({
    id: `documentation-drift`,
    title: `Re-read the documentation against the code`,
    icon: `file`,
    description: `Whether what the documents claim is still what the code does — the drift no tool can measure.`,
    diagnosis: `Documentation is trusted in proportion to how recently it was true, and a document that is quietly wrong is worse than a missing one.`,
    goal:
        `Read this repository's architecture documents against the code they describe. Report every claim that is no longer true, citing the ` +
        `document line and the file that contradicts it. Prioritise the claims someone would ACT on — where a subsystem lives, what owns ` +
        `what, which file to change — over prose that has merely aged. Do not rewrite the documents; produce the list of what is wrong.`,
    done: `Done when every architecture document has been read and every false claim is listed with both sides cited.`,
    cadenceDays: 90,
    applies: (signals) => (signals.shape.docs.length > 0 ? undefined : `this repository has no architecture documents to re-read`),
});

/* THE TWO CHORES THAT ONLY EXIST WHERE THEIR SUBJECT DOES. Both are surveys — nothing here can measure whether a
 * pipeline caches well or an image is bigger than it needs to be without running them, and running someone's CI
 * to find out would be a strange thing for a maintenance panel to do — so both are gated on the artefact itself.
 * Together they are the argument for `applies` being first-class rather than folded into `assess`: neither has
 * any evidence to be absent, and in a repository with no pipeline and no image both would otherwise sit in the
 * list forever, permanently due, describing work that cannot be done. */
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
        `because it genuinely has to be, say so — a pipeline that is honestly expensive is not a finding.`,
    done: `Done when every finding names a file, a step, and a concrete change, and anything deliberately slow is called out as such.`,
    cadenceDays: 90,
    applies: (signals) => (signals.shape.ci.length > 0 ? undefined : `this repository defines no CI pipeline`),
});

const images = survey({
    id: `docker-image`,
    title: `Slim the container image`,
    icon: `box`,
    description: `Layer order, build context and final size — what ships in the image that did not need to.`,
    diagnosis: `Image size is paid on every pull and every cold start, and layer order decides how much of a build is cache hits.`,
    goal:
        `Read this repository's Dockerfiles and report what makes the image larger or the build slower than it needs to be: layers ordered ` +
        `so that a source edit invalidates the dependency install, build-time toolchains left in the final stage, a build context that ships ` +
        `the whole repository, and package caches never cleaned. For each, cite the file and line, and name the change. Do not rewrite the ` +
        `Dockerfiles — an image that fails to build is a much worse problem than one that is larger than ideal.`,
    done: `Done when every finding cites a Dockerfile line and names the change, with the ones that would need a base-image swap called out separately.`,
    cadenceDays: 90,
    applies: (signals) => (signals.shape.dockerfiles.length > 0 ? undefined : `this repository ships no Dockerfile`),
});

/* THE BOOK'S ORDER, which is the panel's reading order and therefore a product decision rather than whatever
 * order these were written in. It narrows from "this is a risk you are carrying right now" to "this is worth
 * thinking about this quarter".
 *
 * This used to be a comment above a hand-sorted array — the four kinds named in prose, the order maintained by
 * whoever added the last chore, and nothing anywhere that could check the two agreed. It was also thrown away at
 * render: the panel listed every chore in one flat column, so the single editorial claim this surface makes
 * ("a live advisory and a quarterly re-read are not the same kind of thing") was invisible and therefore
 * unarguable — on a page whose whole design is that every claim shows its working.
 *
 * So the kinds are data. They order the book here, they group the rows in the panel, and `caption` is the
 * sentence the panel puts beside each group so the grouping argues for itself.
 *
 * Ordering is by KIND, not by whether a given repository will see them: a chore that does not apply is dropped
 * from that repository's list entirely (verdict.ts), so the reading order never has holes in it. It is also why
 * a block of chores written together does not READ together: the front-end four are one paragraph in this file
 * because they share a gate and a probe, and `kind` is what puts a Vue repository's bundle row next to its
 * dependency row rather than in a "front-end" section at the bottom. Where a chore is written and where it is
 * ranked are two separate facts, and only one of them is a product decision. */
export interface ChoreKindSpec {
    readonly kind: ChoreKind;
    // Title case, because the panel renders it as a group heading rather than as a sentence.
    readonly label: string;
    // Why these belong together, in the reader's terms — what the group is CLAIMING about the rows under it.
    readonly caption: string;
}

export const CHORE_KINDS: readonly ChoreKindSpec[] = [
    { kind: `carrying`, label: `Carrying`, caption: `a risk this repository is running today — someone else decides when it becomes urgent` },
    { kind: `accruing`, label: `Accruing`, caption: `cheap now, expensive later, and always getting later` },
    { kind: `drifting`, label: `Drifting`, caption: `the shape of the thing is diverging from the idea of it` },
    { kind: `surveying`, label: `Surveying`, caption: `periodic reads with nothing measuring them — due because it has been that long` },
];

// Declaration order, which decides nothing but the order WITHIN a kind — the sort below is stable, so the two
// facts stay separable: this list is where a chore is written down, CHORE_KINDS is where it is ranked.
const BOOK: readonly Chore[] = [
    security,
    runtime,
    dependencies,
    deadCode,
    complexity,
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

// Sorted rather than filtered into groups, so no chore can ever be dropped out of the book by a kind the list
// above forgot — a missing kind sorts to the front, where it is visible, instead of vanishing.
export const CHORES: readonly Chore[] = BOOK.toSorted((left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind));

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
        // The RULE before the numbers. An agent told only "4 majors waiting" has to infer why anyone cares; told
        // the criterion it was woken by, it can also tell us the criterion was wrong — which is the single most
        // useful thing a chore turn can report back, and the only way the book gets better.
        why: `${finding.why} You were woken because: ${chore.criterion} ${TRIAGE_NOTE}`,
        diagnosis: chore.diagnosis,
        goal: chore.goal,
        invariants: chore.stance === `act` ? CHORE_INVARIANTS : REPORT_INVARIANTS,
        done: chore.done,
    });
