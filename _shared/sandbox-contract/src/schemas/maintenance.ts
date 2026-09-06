// maintenance: the standing evidence a chore is decided from
import { z } from "zod";
import { WorkspaceHotspotSchema, WorkspaceKeyModuleSchema } from "./codebase-health.js";
/* THE DAEMON SERVES FACTS; THE BROWSER DECIDES. Everything below is measurement, what a tool reported, what the
 * manifests say, when a chore last ran. Not one field here says "you should do something", and that is the whole
 * boundary: which chore is DUE is computed by @intentic/sandbox-contract/chores, which both the Maintenance view and its rail
 * badge run, so the number on the tile and the reason in the panel can never disagree. Put the verdict on the wire
 * instead and a daemon one image behind would be quietly arguing with the browser about what needs doing.
 *
 * The split inside the evidence is by COST, not by subject:
 *   probes   subprocesses (pnpm outdated, pnpm audit, knip, jscpd), minutes, so they are cached on disk with a
 *            TTL and refreshed by a background runner. A route hit never waits on one.
 *   signals  things the daemon already knows, the resident iq index's health ranking, the package manifests it
 *            reads for the dependency graph, its own node version. Recomputed per request; all of it is cheap. */

export const PROBE_IDS = ["outdated", "audit", "knip", "jscpd", "ui", "bundle", "mutation"] as const;
export const ProbeIdSchema = z.enum(PROBE_IDS);
export type ProbeId = z.infer<typeof ProbeIdSchema>;
// One dependency the registry has moved past. `kind` is the SEMVER distance, which is the whole reason this is
// not one number: forty patch releases behind is a morning's work and one major is a project.
export const OutdatedPackageSchema = z.object({
    name: z.string().describe("The dependency."),
    current: z.string().describe("What you are on."),
    latest: z.string().describe("What is published."),
    kind: z
        .enum(["major", "minor", "patch"])
        .describe(
            "How far apart those are. This is not one number because forty patch releases behind is a morning's work and one major version is a project.",
        ),
    // "dependencies" / "devDependencies" / "optionalDependencies", a dev-only major is a different risk.
    section: z
        .string()
        .describe("Which part of the manifest declares it. A major version behind on a build-time tool is a different risk from one that ships."),
});
export type OutdatedPackage = z.infer<typeof OutdatedPackageSchema>;
// One advisory, reduced to what a decision needs. No CVSS vector and no reference list: those are for reading on
// the advisory page, and carrying them would put a kilobyte of prose per finding on every poll of this route.
export const AdvisorySchema = z.object({
    name: z.string().describe("The dependency it concerns."),
    severity: z.enum(["critical", "high", "moderate", "low", "info"]).describe("How bad it is said to be."),
    title: z
        .string()
        .describe(
            "What it is, in one line. No scoring vector and no reference list: those are for reading on the advisory's own page, and carrying them would put a kilobyte of prose per finding on every poll.",
        ),
    // The range that fixes it, when the advisory names one. Absent ⇒ no patch published yet, which is the case
    // where a chore must NOT offer to bump and say so instead.
    patched: z
        .string()
        .optional()
        .describe(
            "Which versions fix it. Absent means no fix has been published, which is exactly when nothing should offer to upgrade and something should say so instead.",
        ),
    // Whether it reaches a production dependency path. A build-time-only tool's transitive CVE is a different
    // problem, and the chore's prompt says so rather than treating every advisory alike.
    dev: z.boolean().describe("Whether it only reaches build-time tooling, which is a different problem from one that reaches what you ship."),
});
export type Advisory = z.infer<typeof AdvisorySchema>;
// knip's counts, by the kind of thing it found unreachable. Counts plus a sample rather than the full list: the
// agent re-runs knip itself against the live tree (a list from a probe hours old would send it at files that are
// already gone), so what travels here only has to be enough to decide whether the turn is worth starting.
export const DeadCodeSchema = z.object({
    files: z.number().int().nonnegative().describe("Files nothing reaches."),
    exports: z.number().int().nonnegative().describe("Exported things nothing uses."),
    types: z.number().int().nonnegative().describe("Types nothing uses."),
    dependencies: z.number().int().nonnegative().describe("Declared dependencies nothing imports."),
    devDependencies: z.number().int().nonnegative().describe("The same, for build-time ones."),
    // A handful of the unreferenced files, for the panel to show instead of asking the reader to take "31" on faith.
    sample: z
        .array(z.string())
        .describe(
            "A handful of the files, so a reader need not take the count on faith. Counts and a sample rather than the whole list, because an agent re-measures against the live tree anyway.",
        ),
});
export type DeadCode = z.infer<typeof DeadCodeSchema>;
// jscpd's headline plus the biggest clones. `percentage` is of scanned lines, which is the figure a threshold is
// worth setting against, a clone COUNT grows with the repo and would mean something different every quarter.
export const DuplicationSchema = z.object({
    percentage: z
        .number()
        .describe(
            "How much of the scanned code is duplicated. A share rather than a count, because a count grows with the repository and would mean something different every quarter.",
        ),
    clones: z.number().int().nonnegative().describe("How many duplicated stretches were found."),
    top: z
        .array(
            z.object({
                lines: z.number().int().nonnegative().describe("How long the duplicated stretch is."),
                first: z.string().describe("One of the two places."),
                second: z.string().describe("The other."),
            }),
        )
        .describe("The largest of them."),
});
export type Duplication = z.infer<typeof DuplicationSchema>;
/* ONE SWEEP OF THE UI SOURCE, serving three chores. Component files, Tailwind classes that hard-code a value, and
 * files still on a replaced framework idiom are three questions about the same tree, and asking them in three
 * probes would walk it three times for nothing.
 *
 * Counts per FILE rather than the matched text. A reader deciding whether to open something is served better by
 * "Checkout.vue · 11 hard-coded values" than by eleven class attributes, and a file path is an identity a digest
 * can be built from while a class string is not. */
export const UiScanSchema = z.object({
    // Framework-shaped source files, tests, stories and generated output excluded. The inventory that makes a
    // duplication finding a COMPONENT duplication finding rather than a generic one.
    components: z.array(z.string()).describe("The interface's own source files, with tests, stories and generated output left out."),
    // Where the design system was routed around, and how often in each file.
    bypasses: z
        .array(
            z.object({
                path: z.string().describe("The file."),
                count: z.number().int().positive().describe("How many times, in that file."),
            }),
        )
        .describe(
            "Where the design system was routed around and a value hard-coded instead. Counted per file, because a reader deciding what to open is served by a file and a number, not by eleven snippets.",
        ),
    // Files still on an idiom their framework has replaced, grouped by which one. `id` is looked up in the stack
    // table rather than enumerated here: the rules are a product decision that ships with the browser, and a
    // daemon an image behind must be able to report one this schema has never heard of.
    idioms: z
        .array(
            z.object({
                id: z
                    .string()
                    .describe(
                        "Which outdated idiom. Looked up rather than listed here, so a sandbox one version behind can still report one this list has never heard of.",
                    ),
                files: z.array(z.string()).describe("The files still on it."),
            }),
        )
        .describe("Files still written the way their framework has since replaced."),
});
export type UiScan = z.infer<typeof UiScanSchema>;
/* WHAT THE LAST BUILD ACTUALLY PRODUCED. Measured from the build output already on disk, never by running the
 * build: a maintenance probe that mutates the owner's working tree, and `dist/` appearing in their `git status`
 * is exactly that, is a worse surprise than a measurement that is sometimes a commit behind. It also means this
 * never needs the env vars, secrets or network a real production build would.
 *
 * Gzip alongside raw because gzip is what crosses the wire, and the ratio between them is the difference between
 * "this chunk is big" and "this chunk is big and incompressible", which are different problems. */
export const BundleSchema = z.object({
    // Which directory was measured, so the panel can say what it is talking about rather than implying it built.
    dir: z
        .string()
        .describe(
            "Which folder was measured. Read from build output already on disk rather than by building, so this is sometimes a commit behind and never leaves anything in your working tree.",
        ),
    totalBytes: z.number().int().nonnegative().describe("The whole thing, raw."),
    totalGzip: z
        .number()
        .int()
        .nonnegative()
        .describe(
            "The whole thing, compressed. The ratio between the two is the difference between big and big-and-incompressible, which are different problems.",
        ),
    assets: z
        .array(
            z.object({
                path: z.string().describe("The file."),
                bytes: z.number().int().nonnegative().describe("Its raw size."),
                gzip: z.number().int().nonnegative().describe("Its compressed size."),
            }),
        )
        .describe("What is in it, piece by piece."),
});
export type Bundle = z.infer<typeof BundleSchema>;
/* WHAT THE SUITE WOULD NOTICE IF THE CODE BROKE. Coverage says a line ran; this says an assertion depended on it.
 *
 * The distinction is the whole reason this probe exists, and it is not theoretical here. Measured on
 * sandbox-contract's chore module — 109 hand-written tests, every line covered — 16 of 58 mutants survived, and
 * one of them flips the zero boundary in `bucketOf` that digest.ts's own comment argues is load-bearing. The test
 * that was supposed to hold it (`expect(bucketOf(0)).not.toBe(bucketOf(1))`) is written in the careful,
 * deliberately un-brittle style, and that is exactly why it cannot see the change: with the boundary moved the two
 * values are still different, so the assertion still passes.
 *
 * That is the failure this measures and nothing else in the repository can. A linter sees the assertion's shape,
 * not its power; a coverage report sees the line, not whether anything checked it. Only killing the code and
 * watching what the suite says distinguishes a test from a test-shaped thing.
 *
 * SURVIVORS, NOT JUST A SCORE. A percentage is a mood; `bucketOf: count <= 0 → count < 0 survives` is a morning's
 * work with the answer already in it. The score decides whether the chore speaks, the survivors are what makes it
 * worth speaking about. */
export const MutationScoreSchema = z.object({
    score: z
        .number()
        .describe("The share of injected faults the suite caught. Not a coverage figure: coverage says a line ran, this says an assertion depended on it."),
    killed: z.number().int().nonnegative().describe("Faults the suite caught."),
    survived: z.number().int().nonnegative().describe("Faults it did not: code that can be broken with every test still green."),
    /* Mutants that never got a verdict: ones that would not compile, and ones the configuration ignored. Kept
     * apart from both counts above, and OUT of the score, because an unmeasured mutant is not evidence either
     * way — the same conflation `unavailable` exists to prevent one level up.
     *
     * A timeout is deliberately NOT here. Stryker counts it as detected, on the reasoning that a mutant which
     * hangs the suite is one the suite noticed, and this follows Stryker's arithmetic rather than inventing a
     * second definition of the same word: the number on the row has to mean what the tool that produced it
     * means, or the row is quietly arguing with its own evidence. */
    inconclusive: z
        .number()
        .int()
        .nonnegative()
        .describe("Faults it never got a verdict on, because they would not compile or were configured out. Left out of the score entirely, since neither answer is known."),
    /* The worst offenders, named. Capped, and the cap is the point: a survivor list is only useful while it is
     * short enough to act on, and the rest are still there on the next run. */
    survivors: z
        .array(
            z.object({
                file: z.string().describe("Where it is."),
                line: z.number().int().nonnegative().describe("Which line."),
                mutator: z.string().describe("What was changed, in the mutation tool's own vocabulary."),
                replacement: z.string().describe("What it became, so a reader can judge whether it matters without opening the file."),
            }),
        )
        .describe("The surviving faults themselves. A percentage is a mood; a named line with the change that went unnoticed is a morning's work."),
});
export type MutationScore = z.infer<typeof MutationScoreSchema>;
/* One probe's cached result. The three states are deliberately distinct, because a panel that collapses them
 * lies about the most important case:
 *   ok           the tool ran and reported. `facts` carries its findings, including "nothing found", which is
 *                a real answer and the one that keeps a chore quiet.
 *   unavailable  the tool is not part of this repo (knip is not a devDependency, there is no lockfile to audit).
 *                Not a failure and not evidence of health: the chore renders as unmeasured, and can never badge.
 *   failed       the tool ran and broke, a network-less audit, a jscpd that ran out of memory. Says so, with
 *                the tail of what it printed, rather than reading as "clean".
 * Merging `unavailable` into `ok`-with-zeros is how a maintenance surface ends up reporting a green repository
 * it has never actually measured. */
export const ProbeStateSchema = z.enum(["ok", "unavailable", "failed"]);
export type ProbeState = z.infer<typeof ProbeStateSchema>;
// The findings, discriminated by which probe produced them. Absent while the probe has never completed, and on
// `unavailable`/`failed`, a reader must go through `state` to reach facts, so there is no shape in which a
// missing measurement can be mistaken for a zero.
export const ProbeFactsSchema = z.discriminatedUnion("id", [
    z.object({ id: z.literal("outdated"), packages: z.array(OutdatedPackageSchema) }),
    z.object({ id: z.literal("audit"), advisories: z.array(AdvisorySchema) }),
    z.object({ id: z.literal("knip"), deadCode: DeadCodeSchema }),
    z.object({ id: z.literal("jscpd"), duplication: DuplicationSchema }),
    z.object({ id: z.literal("ui"), scan: UiScanSchema }),
    z.object({ id: z.literal("bundle"), bundle: BundleSchema }),
    z.object({ id: z.literal("mutation"), mutation: MutationScoreSchema }),
]);
export type ProbeFacts = z.infer<typeof ProbeFactsSchema>;
export const ProbeResultSchema = z.object({
    id: ProbeIdSchema.describe("Which measurement this is."),
    state: ProbeStateSchema.describe(
        "Whether the tool ran and reported, is not part of this repository at all, or broke. The middle one is not evidence of health: the check simply cannot be made here.",
    ),
    // When the probe last COMPLETED, the age the panel shows, and what the runner's TTL is measured from.
    ranAt: z.number().describe("When it last finished, in milliseconds, which is what its age is measured from."),
    // How long it took. Shown because a seven-minute jscpd is why the tier-2 refresh is weekly, and a reader
    // deciding whether to force a refresh deserves to know what they are asking for.
    tookMs: z.number().int().nonnegative().describe("How long it took. Worth knowing before asking for it again: some of these run for minutes."),
    facts: ProbeFactsSchema.optional().describe(
        "What it found, including finding nothing, which is a real answer and the one that keeps a chore quiet.",
    ),
    // On `failed`, how it broke, a bounded quote of the tool's own output, never a summary of it. On
    // `unavailable`, what is missing, in the probe spec's own words ("no lockfile"): there is no tool output to
    // quote when the tool never ran, and the alternative, a sentence built from the probe's name, would have an
    // unmeasured probe claiming there is nothing to measure.
    reason: z
        .string()
        .optional()
        .describe(
            "Why it broke, quoted from the tool rather than summarised, or, when it never ran, what is missing. Never a sentence built from the check's own name, which would have an unmeasured check claiming there is nothing to measure.",
        ),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;
// One workspace package as its manifest declares it, what the daemon already reads to build the dependency
// graph, carried through so chores can reason about the repo's own shape without a probe. `documented` is the
// one derived field: whether <dir>/README.md exists, a stat per package. A package's architecture document IS
// its README in this workspace, which is what makes that a stat on the package itself rather than a lookup.
export const ChorePackageSchema = z.object({
    dir: z.string().describe("Where the package lives."),
    name: z.string().describe("What it declares itself as."),
    // The manifest's `engines` map, verbatim, the runtime chore compares it against what the daemon is running.
    engines: z.record(z.string(), z.string()).optional().describe("Which runtime versions it says it needs, verbatim."),
    dependencies: z.array(z.string()).describe("What it depends on."),
    devDependencies: z.array(z.string()).describe("What it needs only to build."),
    documented: z.boolean().describe("Whether it has a README, which in this workspace is what a package's own documentation is."),
});
export type ChorePackage = z.infer<typeof ChorePackageSchema>;
/* The cheap half of the evidence: what the daemon knows without starting anything. `hotspots` and `keyModules`
 * are the same rankings GET /workspace/health serves, capped tighter, a chore only ever asks whether a file has
 * ENTERED the top of the ranking, so a leaderboard is enough and a full report per repo per poll is not. */
/* WHAT THIS REPOSITORY IS MADE OF, the facts that decide whether a chore is a QUESTION worth asking of it at
 * all, as opposed to whether the answer happens to be yes.
 *
 * The distinction is the difference between a maintenance surface that reads as attentive and one that reads as
 * generic. "Re-read the documentation against the code" in a repository with no documentation is not a chore
 * that is currently clear, it is a chore that will never make sense here, and showing it teaches the owner that
 * this list was written by someone who had not looked. Same for a Docker chore with no Dockerfile, or a CI chore
 * with no pipeline.
 *
 * These are all paths, deliberately: presence of a FILE is checkable, cheap, and cannot be argued with, which is
 * the same evidence-over-identity rule the extension activation facts follow. Every field is a list rather than a
 * boolean where the paths themselves are worth showing, a chore that says "not applicable: no Dockerfile" is
 * useful, and one that says "3 Dockerfiles: ./Dockerfile, _editor/web/Dockerfile, …" is more so. */
export const ChoreShapeSchema = z.object({
    // The repository MAP, when one exists (docs/architecture/*.md), capped, the count is what matters, and the
    // drift survey needs to know there is something to re-read. Package pages are READMEs and are counted per
    // package by `ChorePackage.documented`; a repo with a map has been through the documentation flow at all,
    // which is the question this gate actually asks.
    docs: z
        .array(z.string())
        .describe(
            "The repository's own architecture documents, when it has any. Their existence is the question: a repository with none has never been through the documentation flow at all.",
        ),
    dockerfiles: z.array(z.string()).describe("Container definitions in it."),
    // CI pipeline definitions: .github/workflows/*.yml, .gitlab-ci.yml, and the other single-file conventions.
    ci: z.array(z.string()).describe("Pipeline definitions in it."),
    // Whether dependencies are resolved to a lockfile, what makes an audit mean anything.
    lockfile: z.boolean().describe("Whether dependencies are pinned to exact versions, which is what makes a security audit mean anything."),
    // A package.json at the repo root. The gate for every chore whose subject is the JavaScript dependency tree:
    // a Rust or Go repository has no majors to be behind on and no engines field to be pinned by, and offering it
    // those chores would be this surface guessing at what it is looking at.
    packageManifest: z
        .boolean()
        .describe(
            "Whether it is a JavaScript project at all. A Rust or Go repository has no majors to be behind on, and offering it those checks would be this surface guessing at what it is looking at.",
        ),
    /* EVERY DEPENDENCY NAME DECLARED ANYWHERE IN THE REPO, the root manifest's blocks unioned with every
     * workspace package's, sorted and deduplicated.
     *
     * It is here rather than derived from `packages` because `packages` is EMPTY for a repository that is not a
     * pnpm workspace, and the repositories these names exist to recognise, a Vite app, a Next app, an Angular
     * CLI project, are overwhelmingly single-package. A framework gate built on `packages` would be dark in
     * exactly the repositories it was written for, silently, which is the worst way for a gate to be wrong.
     *
     * NAMES, not a `framework: "react"` verdict. Which names amount to "this is a React app" is a product
     * decision, and product decisions live in the chore book that ships with the browser, a daemon baked into an
     * image months ago must not be the thing that decides Svelte is not a UI framework. */
    deps: z
        .array(z.string())
        .describe(
            "Every dependency name declared anywhere in the repository. Names rather than a verdict about which framework this is, because that judgement belongs to whatever reads this, not to a sandbox baked months ago.",
        ),
});
export type ChoreShape = z.infer<typeof ChoreShapeSchema>;
export const ChoreSignalsSchema = z.object({
    packages: z.array(ChorePackageSchema).describe("Each package in the repository, as its own manifest declares it."),
    shape: ChoreShapeSchema.describe("What the repository is made of, which decides whether a given chore is even a sensible question to ask of it."),
    hotspots: z
        .array(WorkspaceHotspotSchema)
        .describe(
            "Files that change often and are complicated at once, capped tight: a chore only asks whether something has entered the top of the ranking.",
        ),
    keyModules: z.array(WorkspaceKeyModuleSchema).describe("The parts the rest of the code leans on most, capped the same way."),
    totals: z
        .object({
            files: z.number().describe("Files counted."),
            symbols: z.number().describe("Named things they export."),
            complexity: z.number().describe("Branch points added up."),
            hotspots: z.number().describe("How many files qualify as hotspots at all."),
        })
        .describe("The repository in numbers."),
    // Whether the index these rankings came from is current. A chore must not fire on a half-built index, and
    // this is how the browser knows to hold its verdict rather than act on a partial ranking.
    indexed: z.boolean().describe("Whether the index these rankings came from is finished. Nothing should act on a half-built one."),
});
export type ChoreSignals = z.infer<typeof ChoreSignalsSchema>;
// What a finished chore turn left behind, written by the agent, read back to decide whether the chore is still
// due. `clean` is the important one: an agent that looked and found the tool's findings to be false positives
// must be able to say so, or the next poll starts the same turn again forever.
export const ChoreOutcomeSchema = z.enum(["acted", "reported", "clean"]);
export type ChoreOutcome = z.infer<typeof ChoreOutcomeSchema>;
/* One chore's history in one repo. The DIGEST is what makes this a debounce rather than a suppression: it is a
 * hash of the evidence that was standing when the turn ran, so a chore whose evidence has since changed is due
 * again on its own merits while one whose evidence is unchanged stays quiet, with the run still visible in the
 * panel, saying when it ran and what it concluded. Nothing here can hide a chore from the view; it only decides
 * whether the rail is allowed to speak. */
export const ChoreLedgerEntrySchema = z.object({
    repo: z.string().describe("Which repository."),
    chore: z.string().describe("Which chore."),
    ranAt: z.number().describe("When it ran, in milliseconds."),
    runId: z.string().describe("The conversation that ran it, so its whole record can be opened."),
    outcome: ChoreOutcomeSchema.describe(
        "What it concluded: it did something, it wrote something down, or it looked and found the finding to be false. That last one matters most, or the same turn starts again for ever.",
    ),
    digest: z
        .string()
        .describe(
            "A fingerprint of the evidence standing at the time. A chore whose evidence has since changed is due again on its own merits; one whose evidence has not stays quiet.",
        ),
    // Set by the owner from the panel, the chore stays visible and stays out of the badge until this passes.
    // Distinct from opting out, which is the absence of the chore from `enabled` in the sandbox's settings.
    snoozedUntil: z
        .number()
        .optional()
        .describe(
            "Not until then, in milliseconds. The chore stays visible and stays out of the badge. Different from switching it off, which is a setting.",
        ),
});
export type ChoreLedgerEntry = z.infer<typeof ChoreLedgerEntrySchema>;
/* A measurement that is HAPPENING, as opposed to one that has happened. The probe cache can only ever describe
 * finished work, `ranAt` is the completion stamp, so a surface reading it alone has no way to say "we are
 * measuring this right now", and the panel's re-measure button spent its whole life looking like it did nothing:
 * the request is an ack, the sweep takes minutes, and every visible fact on the row went on describing the
 * measurement it was replacing.
 *
 * `startedAt` is when the probe actually began, absent while it is still waiting behind another one, the runner
 * has ONE lane across the whole sandbox, so "queued" is a real and common state, and a reader told "measuring"
 * about a probe that has not started is being lied to about how long it has left. */
export const RunningProbeSchema = z.object({
    repo: z.string().describe("Which repository."),
    id: ProbeIdSchema.describe("Which measurement."),
    // When this was asked for. Always present, so a waiting probe can still say how long it has been waiting.
    askedAt: z.number().describe("When it was asked for, in milliseconds, so one still waiting can say how long it has waited."),
    startedAt: z
        .number()
        .optional()
        .describe(
            "When it actually began. Absent while it is queued behind another, which is a real and common state: there is one lane for the whole sandbox.",
        ),
});
export type RunningProbe = z.infer<typeof RunningProbeSchema>;
// GET /chores, every discovered repo's standing evidence, plus the ledger, in one read. One route rather than
// one per repo because the rail badge scans ALL of them on a timer, and N requests a minute to answer "is
// anything due" is the kind of poll that shows up in a battery graph.
export const ChoresReportSchema = z.object({
    repos: z
        .array(
            z.object({
                repo: z.string().describe("Which repository."),
                probes: z
                    .array(ProbeResultSchema)
                    .describe("The expensive measurements, served from a cache with an age on each rather than run on demand."),
                signals: ChoreSignalsSchema.describe("The cheap facts, worked out fresh every time."),
            }),
        )
        .describe(
            "Every repository's standing evidence. One answer for all of them, because a badge polls this on a timer and one request per repository is the kind of poll that shows up in a battery graph.",
        ),
    ledger: z.array(ChoreLedgerEntrySchema).describe("What has already been done about all of it."),
    // What the runner is measuring and what is waiting behind it, right now. Part of the standing read rather
    // than a route of its own: it is the same question ("what does this repo currently say") asked about work in
    // flight, and a panel that had to ask twice would show the two halves disagreeing.
    running: z
        .array(RunningProbeSchema)
        .describe(
            "What is being measured right now and what is waiting behind it. Part of this read rather than a route of its own, because a screen that had to ask twice would show the two halves disagreeing.",
        ),
    // The daemon's own runtime, for the chore that asks whether this sandbox is running something end-of-life.
    // Read off the process rather than a manifest: what is INSTALLED is the fact that matters, and an `engines`
    // range is a wish.
    node: z
        .string()
        .describe(
            "The runtime version this sandbox is actually running, read off the process rather than off a manifest, because what is installed is the fact that matters and a declared range is a wish.",
        ),
});
export type ChoresReport = z.infer<typeof ChoresReportSchema>;
// POST /chores/probe, force one probe to re-run now, ahead of its TTL. Returns immediately; the runner does the
// work and the next GET /chores carries the result, the same shape the panel already polls.
export const ChoreProbeRequestSchema = z.object({
    repo: z.string().min(1).describe("Which repository."),
    id: ProbeIdSchema.describe("Which measurement to retake, ahead of its usual schedule."),
});
// POST /chores/ledger, record a run, or snooze. Written daemon-side rather than by the browser so a chore turn
// started from anywhere (the panel, an automation, the agent itself) lands in one ledger.
export const ChoreLedgerWriteSchema = ChoreLedgerEntrySchema;
/* One publishability check and what it found. `warn` is a real third state, not a soft failure: the permissions
 * check has nothing to say about an extension nobody has exercised yet, and reporting that as a pass would be
 * the check lying at the exact moment it matters most. */
export const ReadinessCheckSchema = z.object({
    id: z.string().describe("Which check."),
    label: z.string().describe("What it is called."),
    status: z.enum(["pass", "warn", "fail"]).describe("How it went. A warning is a real third answer rather than a soft failure."),
    detail: z.string().describe("What it found."),
});
export const ExtensionReadinessSchema = z.object({
    checks: z.array(ReadinessCheckSchema).describe("Everything that can be checked from the extension's own files, for an author about to publish."),
});
