import { assessReport, digestOf, ledgerKey } from "@intentic/sandbox-contract/chores";
import type { ChoreLedgerEntry, ChoresReport, ProbeResult } from "@intentic/sandbox-contract";

/* MAINTENANCE, RECORDED — the evidence `GET /chores` carries for acme-shop, and the ledger of what has already
 * been done about it.
 *
 * The daemon measures and the browser decides: this route answers with MEASUREMENTS (probe results, package
 * facts, the hotspot ranking) and never with verdicts, because the chore book that turns those into "due" or
 * "clear" ships in the app. So the fixture's job is to be a plausible repository, not to choose what the panel
 * says — every row a visitor reads is computed from the numbers below by the same function that runs against a
 * real daemon.
 *
 * WHAT THE NUMBERS ARE CHOSEN TO PRODUCE is one row of each kind the surface distinguishes, because the
 * distinctions are the design:
 *   due            a high advisory reaching production, two majors waiting, dead code, a tangled hotspot
 *   snoozed        the API's dependency drift — the owner said "not this cycle"
 *   clear          duplication in the API, checked by an agent that reported the findings did not hold up
 *   unavailable    knip is not a devDependency of the API, so its dead code is UNMEASURED, not clean
 *   not applicable no Dockerfile in the storefront, no packages to document one by one, no docs in the API
 *
 * The two `clear` states are the ones worth having: a maintenance panel that can only show complaints cannot be
 * used to check that there are none. */

// What this sandbox runs. A supported LTS, so the runtime chore reads `clear` — a recording that opened on an
// end-of-life warning would be shouting about the box rather than about the code.
const NODE = `v22.14.0`;

const DAY = 86_400_000;

const probe = (id: ProbeResult["id"], ranAtDaysAgo: number, tookMs: number, facts: ProbeResult["facts"], now: number): ProbeResult => ({
    id,
    state: `ok`,
    ranAt: now - ranAtDaysAgo * DAY,
    tookMs,
    facts,
});

/* THE STOREFRONT'S EVIDENCE. Two majors waiting behind a long tail of ordinary drift, one advisory that actually
 * reaches a running page, some code nothing references any more, and a checkout panel that both churns and is
 * imported by everything — which is the shape of a repository somebody is actively shipping. */
const webRepo = (now: number) => ({
    repo: `web`,
    probes: [
        probe(
            `outdated`,
            0.4,
            18_400,
            {
                id: `outdated` as const,
                packages: [
                    { name: `react-router`, current: `6.28.2`, latest: `7.4.0`, kind: `major` as const, section: `dependencies` },
                    { name: `tailwindcss`, current: `3.4.17`, latest: `4.1.3`, kind: `major` as const, section: `devDependencies` },
                    { name: `vite`, current: `7.1.4`, latest: `7.3.0`, kind: `minor` as const, section: `devDependencies` },
                    { name: `@stripe/stripe-js`, current: `4.9.0`, latest: `4.11.2`, kind: `minor` as const, section: `dependencies` },
                    { name: `zod`, current: `4.0.14`, latest: `4.1.6`, kind: `minor` as const, section: `dependencies` },
                    { name: `@playwright/test`, current: `1.56.1`, latest: `1.56.4`, kind: `patch` as const, section: `devDependencies` },
                    { name: `typescript`, current: `5.8.2`, latest: `5.8.3`, kind: `patch` as const, section: `devDependencies` },
                ],
            },
            now,
        ),
        probe(
            `audit`,
            0.4,
            9_100,
            {
                id: `audit` as const,
                advisories: [
                    {
                        name: `image-resize`,
                        severity: `high` as const,
                        title: `Prototype pollution when parsing untrusted image metadata`,
                        patched: `>=3.2.1`,
                        dev: false,
                    },
                    { name: `esbuild`, severity: `moderate` as const, title: `Dev server responds to any origin`, patched: `>=0.25.0`, dev: true },
                ],
            },
            now,
        ),
        probe(
            `knip`,
            2.1,
            41_600,
            {
                id: `knip` as const,
                deadCode: {
                    files: 2,
                    exports: 9,
                    types: 3,
                    dependencies: 1,
                    devDependencies: 0,
                    sample: [`src/pricing/LegacyPlanTable.tsx`, `src/lib/analytics.ts`],
                },
            },
            now,
        ),
        probe(
            `jscpd`,
            2.1,
            126_000,
            {
                id: `jscpd` as const,
                duplication: {
                    percentage: 3.1,
                    clones: 6,
                    top: [
                        { lines: 24, first: `src/pricing/PricingPage.tsx`, second: `src/pricing/LegacyPlanTable.tsx` },
                        { lines: 18, first: `tests/checkout.spec.ts`, second: `tests/signup.spec.ts` },
                    ],
                },
            },
            now,
        ),
    ],
    signals: {
        // Single-package repo: `packages` is empty, exactly as the daemon reports it, which is what makes the
        // document and library chores read "not applicable" rather than inventing one pseudo-package.
        packages: [],
        shape: {
            docs: [`docs/architecture/repo.md`, `docs/architecture/src/pricing/doc.md`, `docs/architecture/src/lib/doc.md`, `docs/architecture/tests/doc.md`],
            dockerfiles: [],
            ci: [`.github/workflows/ci.yml`],
            lockfile: true,
            packageManifest: true,
        },
        hotspots: [
            { path: `src/pricing/CheckoutPanel.tsx`, commits: 34, adds: 812, dels: 396, complexity: 41, score: 0.94, latestMs: now - 90_000 },
            { path: `src/pricing/PricingPage.tsx`, commits: 21, adds: 540, dels: 210, complexity: 18, score: 0.61, latestMs: now - 3 * DAY },
            { path: `src/lib/api.ts`, commits: 12, adds: 190, dels: 84, complexity: 11, score: 0.38, latestMs: now - 6 * DAY },
            { path: `tests/signup.spec.ts`, commits: 9, adds: 260, dels: 180, complexity: 8, score: 0.29, latestMs: now - 2 * DAY },
        ],
        // CheckoutPanel is in both rankings — it churns AND everything imports it, which is the one shape the
        // complexity chore reports rather than laundering a leaderboard into a to-do list.
        keyModules: [
            { path: `src/pricing/CheckoutPanel.tsx`, exports: 6 },
            { path: `src/lib/api.ts`, exports: 4 },
        ],
        totals: { files: 41, symbols: 318, complexity: 96, hotspots: 4 },
        indexed: true,
    },
});

/* THE API'S EVIDENCE. Quieter, and unmeasured in one place on purpose: knip is not a devDependency here, so its
 * dead-code chore has no answer at all — which the panel renders greyed and can never badge. */
const apiRepo = (now: number) => ({
    repo: `api`,
    probes: [
        probe(
            `outdated`,
            0.6,
            11_200,
            {
                id: `outdated` as const,
                packages: [
                    { name: `drizzle-orm`, current: `0.38.4`, latest: `1.0.2`, kind: `major` as const, section: `dependencies` },
                    { name: `stripe`, current: `17.6.0`, latest: `17.9.1`, kind: `minor` as const, section: `dependencies` },
                    { name: `hono`, current: `4.7.1`, latest: `4.7.6`, kind: `patch` as const, section: `dependencies` },
                ],
            },
            now,
        ),
        // Measured, and genuinely clean — the state this surface most needs to be able to show.
        probe(`audit`, 0.6, 7_400, { id: `audit` as const, advisories: [] }, now),
        {
            id: `knip` as const,
            state: `unavailable` as const,
            ranAt: now - 0.6 * DAY,
            tookMs: 120,
            reason: `knip is not a devDependency of this repository`,
        },
        probe(
            `jscpd`,
            4.2,
            84_000,
            {
                id: `jscpd` as const,
                duplication: {
                    percentage: 6.2,
                    clones: 11,
                    top: [
                        { lines: 46, first: `src/routes/checkout.ts`, second: `src/routes/users.ts` },
                        { lines: 31, first: `src/db/migrations.ts`, second: `src/db/schema.ts` },
                    ],
                },
            },
            now,
        ),
    ],
    signals: {
        packages: [],
        // No architecture documents in the repo: the API's set is still a DRAFT (fixture/docs.ts), so the
        // documentation-drift survey has nothing to re-read and says so rather than firing on its cadence.
        shape: { docs: [], dockerfiles: [`Dockerfile`], ci: [`.github/workflows/api.yml`], lockfile: true, packageManifest: true },
        hotspots: [
            { path: `src/routes/checkout.ts`, commits: 16, adds: 380, dels: 120, complexity: 14, score: 0.52, latestMs: now - 4 * 3_600_000 },
            { path: `src/db/schema.ts`, commits: 11, adds: 210, dels: 60, complexity: 9, score: 0.31, latestMs: now - DAY },
        ],
        keyModules: [{ path: `src/db/migrations.ts`, exports: 3 }],
        // Under the cross-cutting-patterns floor (25 indexed files), so that survey reads "not applicable here"
        // — a repository this small has one way of doing things because there is barely more than one place.
        totals: { files: 18, symbols: 142, complexity: 38, hotspots: 2 },
        indexed: true,
    },
});

const evidence = (now: number): ChoresReport["repos"] => [webRepo(now), apiRepo(now)];

/* THE LEDGER — what has already been run, and the one snooze the owner set.
 *
 * Seeded from the verdicts the evidence above actually produces, never from hand-typed digests: a digest that
 * misses is invisible (the row simply reads as never-run), and the two entries that matter here are the two
 * whose whole point is that the digest MATCHES — the settled `clean` verdict and the snooze. Deriving them with
 * the same function the panel uses is the only way that cannot rot when a number above changes. */
const seedLedger = (now: number): ChoreLedgerEntry[] => {
    const verdicts = assessReport({ repos: evidence(now), ledger: [], node: NODE }, now);
    const digestFor = (repo: string, chore: string): string => verdicts.find((verdict) => verdict.repo === repo && verdict.chore.id === chore)?.digest ?? ``;
    const entry = (repo: string, chore: string, daysAgo: number, outcome: ChoreLedgerEntry["outcome"], extra: { snoozedUntil?: number } = {}): ChoreLedgerEntry => ({
        repo,
        chore,
        ranAt: now - daysAgo * DAY,
        runId: `r${(now - daysAgo * DAY).toString(36)}`,
        outcome,
        digest: digestFor(repo, chore),
        ...extra,
    });
    return [
        // Surveys that were read recently enough to be clear — and whose rows say when, which is the only thing
        // "nothing to do" can honestly mean for a review that measures nothing.
        entry(`web`, `standardize-patterns`, 12, `reported`),
        entry(`web`, `deprecated-apis`, 34, `reported`),
        entry(`web`, `documentation-drift`, 40, `reported`),
        entry(`api`, `deprecated-apis`, 20, `reported`),
        entry(`api`, `ci-hygiene`, 61, `reported`),
        // The agent looked at exactly this duplication and reported it was generated code and deliberately
        // repetitive tests. `clean` is what makes that verdict stick until the evidence moves.
        entry(`api`, `duplication`, 3, `clean`),
        // "Not this cycle" — the drizzle major is a project, and the owner said so from the panel.
        entry(`api`, `dependencies-outdated`, 8, `reported`, { snoozedUntil: now + 22 * DAY }),
    ];
};

// Built once and then LIVE: snoozing from the panel and promoting a finished run both write here, and every
// later read reflects it — a fixture that answered read-only would have controls that spring back on next poll.
let ledger: ChoreLedgerEntry[] | undefined;

export const choresReport = (now: number): ChoresReport => ({ repos: evidence(now), ledger: (ledger ??= seedLedger(now)), node: NODE });

/** POST /chores/ledger — record a run, or snooze. One row per repo + chore, newest write wins. */
export const writeLedger = (now: number, written: ChoreLedgerEntry): void => {
    const rows = (ledger ??= seedLedger(now));
    const index = rows.findIndex((row) => ledgerKey(row.repo, row.chore) === ledgerKey(written.repo, written.chore));
    if (index === -1) {
        rows.push(written);
        return;
    }
    rows[index] = written;
};

/* THE RUN HISTORY — a chore turn that already happened, as the files it leaves behind. The manifest is what makes
 * a run discoverable and the result is what the agent wrote when it finished; the panel promotes the pair into a
 * ledger row itself, which is exactly what it will do on this recording's first poll.
 *
 * Its digest is the evidence as it stood THEN, and the storefront's dead code has moved since (the agent deleted
 * two files, knip now reports different ones) — so the row shows what was done without the chore going quiet
 * about what is true now. */
export const choreFiles = (now: number): [string, string][] => {
    const createdAt = now - 2 * DAY;
    const runId = `r${createdAt.toString(36)}0`;
    const dir = `.intentic/chores/runs/${runId}`;
    return [
        [
            `${dir}/run.json`,
            `${JSON.stringify(
                {
                    runId,
                    createdAt,
                    repo: `web`,
                    chore: `dead-code`,
                    digest: digestOf(`src/checkout/OldSessionForm.tsx`, `src/lib/legacyPlans.ts`, `exports:4`, `deps:0`),
                    conversationId: `mt-${runId}`,
                    headline: `4 unreferenced files, 14 unused exports, 1 unused dependency`,
                },
                undefined,
                2,
            )}\n`,
        ],
        [
            `${dir}/result.json`,
            `${JSON.stringify(
                {
                    outcome: `acted`,
                    summary:
                        `Deleted two unreferenced components and the analytics shim nothing imported, and removed the unused ` +
                        `dependency. Left four exports knip flagged: they are the package's public entry points, reachable from tests.`,
                },
                undefined,
                2,
            )}\n`,
        ],
    ];
};
