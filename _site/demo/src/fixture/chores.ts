import { assessReport, digestOf, ledgerKey } from "@intentic/sandbox-contract/chores";
import type { ChoreLedgerEntry, ChoresReport, ProbeResult } from "@intentic/sandbox-contract";

// Evidence `GET /chores` returns for acme-shop, plus its ledger. The route answers only with measurements (probes,
// package facts, hotspots); the app turns them into verdicts. Numbers are chosen so due, snoozed, clear, unavailable
// and not-applicable each have one example.

// Supported Node LTS, so the runtime chore reads `clear`.
const NODE = `v22.14.0`;

const DAY = 86_400_000;

const probe = (id: ProbeResult["id"], ranAtDaysAgo: number, tookMs: number, facts: ProbeResult["facts"], now: number): ProbeResult => ({
    id,
    state: `ok`,
    ranAt: now - ranAtDaysAgo * DAY,
    tookMs,
    facts,
});

// Storefront evidence: two majors pending, one advisory reaching a live page, unreferenced code, and a panel that both
// churns and is imported everywhere.
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
        // Front-end drift: mostly hooks, a price card rebuilt not found, inline colors on rushed pages.
        probe(
            `ui`,
            0.3,
            2_400,
            {
                id: `ui` as const,
                scan: {
                    components: [
                        `src/pricing/CheckoutPanel.tsx`,
                        `src/pricing/PricingPage.tsx`,
                        `src/pricing/LegacyPlanTable.tsx`,
                        `src/pricing/PriceCard.tsx`,
                        `src/checkout/PriceCardV2.tsx`,
                        `src/checkout/AddressForm.tsx`,
                        `src/common/Spinner.tsx`,
                    ],
                    bypasses: [
                        { path: `src/pricing/CheckoutPanel.tsx`, count: 11 },
                        { path: `src/pricing/LegacyPlanTable.tsx`, count: 6 },
                        { path: `src/checkout/AddressForm.tsx`, count: 2 },
                    ],
                    idioms: [
                        { id: `react-class-component`, files: [`src/pricing/LegacyPlanTable.tsx`, `src/common/Spinner.tsx`] },
                        { id: `react-prop-types`, files: [`src/pricing/LegacyPlanTable.tsx`] },
                    ],
                },
            },
            now,
        ),
        // One vendor chunk carries two thirds of the download; no route has been split yet.
        probe(
            `bundle`,
            0.3,
            1_900,
            {
                id: `bundle` as const,
                bundle: {
                    dir: `dist`,
                    totalBytes: 1_612_000,
                    totalGzip: 486_000,
                    assets: [
                        { path: `dist/assets/vendor-DlAUqK2U.js`, bytes: 1_098_000, gzip: 331_000 },
                        { path: `dist/assets/index-B7fQ2xNp.js`, bytes: 372_000, gzip: 112_000 },
                        { path: `dist/assets/checkout-Ck1vRt8s.js`, bytes: 98_000, gzip: 29_000 },
                        { path: `dist/assets/index-Xy4mNb2q.css`, bytes: 44_000, gzip: 14_000 },
                    ],
                },
            },
            now,
        ),
    ],
    signals: {
        // `packages` stays empty, matching how the daemon reports a single-package repo.
        packages: [],
        shape: {
            // `docs` is the architecture map; per-package READMEs are counted separately, via `packages`.
            docs: [`docs/architecture/repo.md`],
            dockerfiles: [],
            ci: [`.github/workflows/ci.yml`],
            lockfile: true,
            packageManifest: true,
            // React + Tailwind here (root manifest, not empty `packages`) is what turns on the four front-end chores.
            deps: [`react`, `react-dom`, `react-router`, `tailwindcss`, `vite`, `image-resize`, `esbuild`],
        },
        hotspots: [
            { path: `src/pricing/CheckoutPanel.tsx`, commits: 34, adds: 812, dels: 396, complexity: 41, score: 0.94, latestMs: now - 90_000 },
            { path: `src/pricing/PricingPage.tsx`, commits: 21, adds: 540, dels: 210, complexity: 18, score: 0.61, latestMs: now - 3 * DAY },
            { path: `src/lib/api.ts`, commits: 12, adds: 190, dels: 84, complexity: 11, score: 0.38, latestMs: now - 6 * DAY },
            { path: `tests/signup.spec.ts`, commits: 9, adds: 260, dels: 180, complexity: 8, score: 0.29, latestMs: now - 2 * DAY },
        ],
        // CheckoutPanel appears in both rankings: high churn and heavily imported, the shape this chore flags.
        keyModules: [
            { path: `src/pricing/CheckoutPanel.tsx`, exports: 6 },
            { path: `src/lib/api.ts`, exports: 4 },
        ],
        totals: { files: 41, symbols: 318, complexity: 96, hotspots: 4 },
        indexed: true,
    },
});

// API evidence, quieter than web's. knip isn't a devDependency here, so dead-code has no answer and renders
// unavailable.
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
        // The one clean, fully measured probe this fixture needs to demonstrate.
        probe(`audit`, 0.6, 7_400, { id: `audit` as const, advisories: [] }, now),
        {
            id: `knip` as const,
            state: `unavailable` as const,
            ranAt: now - 0.6 * DAY,
            tookMs: 120,
            // Matches the daemon's own wording for an unavailable probe.
            reason: `knip is not a devDependency`,
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
        // No arch docs and no UI framework here: doc-drift and the four front-end chores read `not applicable`.
        shape: {
            docs: [],
            dockerfiles: [`Dockerfile`],
            ci: [`.github/workflows/api.yml`],
            lockfile: true,
            packageManifest: true,
            deps: [`fastify`, `pino`, `zod`, `drizzle-orm`],
        },
        hotspots: [
            { path: `src/routes/checkout.ts`, commits: 16, adds: 380, dels: 120, complexity: 14, score: 0.52, latestMs: now - 4 * 3_600_000 },
            { path: `src/db/schema.ts`, commits: 11, adds: 210, dels: 60, complexity: 9, score: 0.31, latestMs: now - DAY },
        ],
        keyModules: [{ path: `src/db/migrations.ts`, exports: 3 }],
        // Below the cross-cutting-patterns floor (25 indexed files): that survey reads `not applicable`.
        totals: { files: 18, symbols: 142, complexity: 38, hotspots: 2 },
        indexed: true,
    },
});

const evidence = (now: number): ChoresReport["repos"] => [webRepo(now), apiRepo(now)];

// Digests come from `assessReport` on the evidence above, not hand-typed, so a digest match (the `clean` row, the
// snooze) can't silently rot.
const seedLedger = (now: number): ChoreLedgerEntry[] => {
    const verdicts = assessReport({ repos: evidence(now), ledger: [], running: [], node: NODE }, now);
    const digestFor = (repo: string, chore: string): string =>
        verdicts.find((verdict) => verdict.repo === repo && verdict.chore.id === chore)?.digest ?? ``;
    const entry = (
        repo: string,
        chore: string,
        daysAgo: number,
        outcome: ChoreLedgerEntry["outcome"],
        extra: { snoozedUntil?: number } = {},
    ): ChoreLedgerEntry => ({
        repo,
        chore,
        ranAt: now - daysAgo * DAY,
        runId: `r${(now - daysAgo * DAY).toString(36)}`,
        outcome,
        digest: digestFor(repo, chore),
        ...extra,
    });
    return [
        // Surveys read recently enough to be `reported`: the only honest 'nothing to do' for an unmeasured review.
        entry(`web`, `standardize-patterns`, 12, `reported`),
        entry(`web`, `deprecated-apis`, 34, `reported`),
        entry(`web`, `documentation-drift`, 40, `reported`),
        entry(`api`, `deprecated-apis`, 20, `reported`),
        entry(`api`, `ci-hygiene`, 61, `reported`),
        // Agent judged this duplication as generated/repetitive test code; `clean` holds until evidence changes.
        entry(`api`, `duplication`, 3, `clean`),
        // Reported due, still due: react-router 7 needs work; run predates the probe, so it's `settled` not `stale`.
        entry(`web`, `dependencies-outdated`, 5, `reported`),
        // Owner snoozed the drizzle major from the panel: 'not this cycle'.
        entry(`api`, `dependencies-outdated`, 8, `reported`, { snoozedUntil: now + 22 * DAY }),
    ];
};

// Built once, then live: snoozes and promoted runs write here and persist across reads.
let ledger: ChoreLedgerEntry[] | undefined;

// No runner behind this demo; `running` stays empty rather than spin forever.
export const choresReport = (now: number): ChoresReport => ({
    repos: evidence(now),
    ledger: (ledger ??= seedLedger(now)),
    running: [],
    node: NODE,
});

/** POST /chores/ledger, record a run, or snooze. One row per repo + chore, newest write wins. */
export const writeLedger = (now: number, written: ChoreLedgerEntry): void => {
    const rows = (ledger ??= seedLedger(now));
    const index = rows.findIndex((row) => ledgerKey(row.repo, row.chore) === ledgerKey(written.repo, written.chore));
    if (index === -1) {
        rows.push(written);
        return;
    }
    rows[index] = written;
};

// Files a finished chore run leaves behind (manifest + result); the panel promotes them into a ledger row on first
// poll. Digest reflects evidence as it stood then, which has since moved.
export const choreFiles = (now: number): [string, string][] => {
    const createdAt = now - 2 * DAY;
    const runId = `r${createdAt.toString(36)}0`;
    const dir = `.intentic/records/chores/runs/${runId}`;
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
