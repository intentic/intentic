// maintenance: the standing evidence a chore is decided from
import { z } from "zod";
import { WorkspaceHotspotSchema, WorkspaceKeyModuleSchema } from "./codebase-health.js";
// The daemon serves facts, never a verdict: which chore is due is computed by shared code
// (`@intentic/sandbox-contract/chores`) so the tile and panel can't disagree. Split by cost: probes (subprocesses,
// cached with a TTL) vs signals (cheap, recomputed per request).

export const PROBE_IDS = ["outdated", "audit", "knip", "jscpd", "ui", "bundle", "mutation"] as const;
export const ProbeIdSchema = z.enum(PROBE_IDS);
export type ProbeId = z.infer<typeof ProbeIdSchema>;
// `kind` is the semver distance; that's why this isn't collapsed to one number.
export const OutdatedPackageSchema = z.object({
    name: z.string().describe("The dependency."),
    current: z.string().describe("What you are on."),
    latest: z.string().describe("What is published."),
    kind: z
        .enum(["major", "minor", "patch"])
        .describe(
            "How far apart those are. This is not one number because forty patch releases behind is a morning's work and one major version is a project.",
        ),
    // "dependencies" / "devDependencies" / "optionalDependencies".
    section: z
        .string()
        .describe("Which part of the manifest declares it. A major version behind on a build-time tool is a different risk from one that ships."),
});
export type OutdatedPackage = z.infer<typeof OutdatedPackageSchema>;
export const AdvisorySchema = z.object({
    name: z.string().describe("The dependency it concerns."),
    severity: z.enum(["critical", "high", "moderate", "low", "info"]).describe("How bad it is said to be."),
    title: z
        .string()
        .describe(
            "What it is, in one line. No scoring vector and no reference list: those are for reading on the advisory's own page, and carrying them would put a kilobyte of prose per finding on every poll.",
        ),
    patched: z
        .string()
        .optional()
        .describe(
            "Which versions fix it. Absent means no fix has been published, which is exactly when nothing should offer to upgrade and something should say so instead.",
        ),
    dev: z.boolean().describe("Whether it only reaches build-time tooling, which is a different problem from one that reaches what you ship."),
});
export type Advisory = z.infer<typeof AdvisorySchema>;
// A stale sample could send the agent chasing files already gone; it re-runs knip live anyway.
export const DeadCodeSchema = z.object({
    files: z.number().int().nonnegative().describe("Files nothing reaches."),
    exports: z.number().int().nonnegative().describe("Exported things nothing uses."),
    types: z.number().int().nonnegative().describe("Types nothing uses."),
    dependencies: z.number().int().nonnegative().describe("Declared dependencies nothing imports."),
    devDependencies: z.number().int().nonnegative().describe("The same, for build-time ones."),
    sample: z
        .array(z.string())
        .describe(
            "A handful of the files, so a reader need not take the count on faith. Counts and a sample rather than the whole list, because an agent re-measures against the live tree anyway.",
        ),
});
export type DeadCode = z.infer<typeof DeadCodeSchema>;
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
// One sweep serving three chores (components, hard-coded values, outdated idioms) rather than three probes walking the
// same tree three times.
export const UiScanSchema = z.object({
    // This inventory is what makes a duplication finding a component finding, not a generic one.
    components: z.array(z.string()).describe("The interface's own source files, with tests, stories and generated output left out."),
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
    // `id` is looked up in the stack table, not enumerated here, so an older daemon can still report an idiom this
    // schema predates.
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
// Read from build output on disk, never by building (no working-tree mutation, no env vars, secrets or network needed).
export const BundleSchema = z.object({
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
// Coverage says a line ran; this says an assertion depended on it — the only way to tell a real test from a test-shaped
// one that can't see the code change under it.
export const MutationScoreSchema = z.object({
    score: z
        .number()
        .describe("The share of injected faults the suite caught. Not a coverage figure: coverage says a line ran, this says an assertion depended on it."),
    killed: z.number().int().nonnegative().describe("Faults the suite caught."),
    survived: z.number().int().nonnegative().describe("Faults it did not: code that can be broken with every test still green."),
    // A timeout counts as detected here (Stryker's own convention), not as inconclusive.
    inconclusive: z
        .number()
        .int()
        .nonnegative()
        .describe("Faults it never got a verdict on, because they would not compile or were configured out. Left out of the score entirely, since neither answer is known."),
    // Capped on purpose: useful only while short enough to act on; the rest reappear next run.
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
// One probe's cached state; collapsing these would lie about the most important case.
// ok: the tool ran and reported (including "nothing found", a real answer).
// unavailable: not part of this repo (no lockfile, tool not a dependency) — not evidence of health, never badges.
// failed: the tool ran and broke; says so, with the tail of its output.
export const ProbeStateSchema = z.enum(["ok", "unavailable", "failed"]);
export type ProbeState = z.infer<typeof ProbeStateSchema>;
// Discriminated by probe id; absent until the probe completes. On unavailable/failed a reader must go through `state`,
// so a missing measurement can never look like a zero.
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
    // Also what the runner's TTL is measured from.
    ranAt: z.number().describe("When it last finished, in milliseconds, which is what its age is measured from."),
    // Slow probes are why some tiers refresh weekly rather than on every poll.
    tookMs: z.number().int().nonnegative().describe("How long it took. Worth knowing before asking for it again: some of these run for minutes."),
    facts: ProbeFactsSchema.optional().describe(
        "What it found, including finding nothing, which is a real answer and the one that keeps a chore quiet.",
    ),
    reason: z
        .string()
        .optional()
        .describe(
            "Why it broke, quoted from the tool rather than summarised, or, when it never ran, what is missing. Never a sentence built from the check's own name, which would have an unmeasured check claiming there is nothing to measure.",
        ),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;
// One workspace package as its manifest declares it, carried through so chores can reason about the repo's shape
// without a probe.
export const ChorePackageSchema = z.object({
    dir: z.string().describe("Where the package lives."),
    name: z.string().describe("What it declares itself as."),
    // Compared against the daemon's own runtime by the version chore.
    engines: z.record(z.string(), z.string()).optional().describe("Which runtime versions it says it needs, verbatim."),
    dependencies: z.array(z.string()).describe("What it depends on."),
    devDependencies: z.array(z.string()).describe("What it needs only to build."),
    documented: z.boolean().describe("Whether it has a README, which in this workspace is what a package's own documentation is."),
});
export type ChorePackage = z.infer<typeof ChorePackageSchema>;
// The cheap half of the evidence: what the daemon already knows without starting anything (same rankings as GET
// /workspace/health, capped tighter).
// Facts that decide whether a chore is even a sensible question to ask, not whether the answer is yes. All paths, not
// booleans: file presence is cheap and checkable, and the paths themselves are worth showing.
export const ChoreShapeSchema = z.object({
    // Distinct from package READMEs, counted per package by `ChorePackage.documented`.
    docs: z
        .array(z.string())
        .describe(
            "The repository's own architecture documents, when it has any. Their existence is the question: a repository with none has never been through the documentation flow at all.",
        ),
    dockerfiles: z.array(z.string()).describe("Container definitions in it."),
    // e.g. .github/workflows/*.yml, .gitlab-ci.yml.
    ci: z.array(z.string()).describe("Pipeline definitions in it."),
    lockfile: z.boolean().describe("Whether dependencies are pinned to exact versions, which is what makes a security audit mean anything."),
    // Also gates the engines-version chore: a Rust/Go repo has none to pin.
    packageManifest: z
        .boolean()
        .describe(
            "Whether it is a JavaScript project at all. A Rust or Go repository has no majors to be behind on, and offering it those checks would be this surface guessing at what it is looking at.",
        ),
    // Not derived from `packages`, which is empty for a non-pnpm-workspace repo — exactly the single-package repos this
    // exists to recognise.
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
    indexed: z.boolean().describe("Whether the index these rankings came from is finished. Nothing should act on a half-built one."),
});
export type ChoreSignals = z.infer<typeof ChoreSignalsSchema>;
// `clean` is the important value: without it, a false-positive finding restarts the same turn forever.
export const ChoreOutcomeSchema = z.enum(["acted", "reported", "clean"]);
export type ChoreOutcome = z.infer<typeof ChoreOutcomeSchema>;
// A debounce, not a suppression: unchanged evidence keeps the rail quiet, but the run stays visible in the panel
// regardless.
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
    snoozedUntil: z
        .number()
        .optional()
        .describe(
            "Not until then, in milliseconds. The chore stays visible and stays out of the badge. Different from switching it off, which is a setting.",
        ),
});
export type ChoreLedgerEntry = z.infer<typeof ChoreLedgerEntrySchema>;
// A measurement in progress, distinct from the cache's `ranAt` (only ever a completion stamp) — otherwise a reader has
// no way to say "measuring now".
export const RunningProbeSchema = z.object({
    repo: z.string().describe("Which repository."),
    id: ProbeIdSchema.describe("Which measurement."),
    askedAt: z.number().describe("When it was asked for, in milliseconds, so one still waiting can say how long it has waited."),
    startedAt: z
        .number()
        .optional()
        .describe(
            "When it actually began. Absent while it is queued behind another, which is a real and common state: there is one lane for the whole sandbox.",
        ),
});
export type RunningProbe = z.infer<typeof RunningProbeSchema>;
// GET /chores: every discovered repo's standing evidence, plus the ledger, in one read.
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
    running: z
        .array(RunningProbeSchema)
        .describe(
            "What is being measured right now and what is waiting behind it. Part of this read rather than a route of its own, because a screen that had to ask twice would show the two halves disagreeing.",
        ),
    node: z
        .string()
        .describe(
            "The runtime version this sandbox is actually running, read off the process rather than off a manifest, because what is installed is the fact that matters and a declared range is a wish.",
        ),
});
export type ChoresReport = z.infer<typeof ChoresReportSchema>;
// POST /chores/probe: force a re-run ahead of its TTL. Returns immediately; the result arrives on the next GET /chores.
export const ChoreProbeRequestSchema = z.object({
    repo: z.string().min(1).describe("Which repository."),
    id: ProbeIdSchema.describe("Which measurement to retake, ahead of its usual schedule."),
});
// POST /chores/ledger: record a run, or snooze. Daemon-written so a turn started from anywhere (panel, automation,
// agent) lands in one ledger.
export const ChoreLedgerWriteSchema = ChoreLedgerEntrySchema;
// `warn` is a real third state, not a soft failure: reporting "pass" when nothing has been exercised yet would be the
// check lying.
export const ReadinessCheckSchema = z.object({
    id: z.string().describe("Which check."),
    label: z.string().describe("What it is called."),
    status: z.enum(["pass", "warn", "fail"]).describe("How it went. A warning is a real third answer rather than a soft failure."),
    detail: z.string().describe("What it found."),
});
export const ExtensionReadinessSchema = z.object({
    checks: z.array(ReadinessCheckSchema).describe("Everything that can be checked from the extension's own files, for an author about to publish."),
});
